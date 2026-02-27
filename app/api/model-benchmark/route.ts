import { NextRequest, NextResponse } from 'next/server'
/**
 * Model benchmark API route.
 * Responsibilities:
 * - Run the same prompt against multiple configured LLMs.
 * - Score response quality/grounding heuristically.
 * - Return ranked results for side-by-side comparison.
 */
import { DEFAULT_RAG_ID, DEFAULT_RAG_TOP_K, DEFAULT_RATE_LIMIT_WINDOW_MS } from '@/lib/config/env'
import { executeAgent } from '@/lib/server/agentRuntime'
import { ensureDataDirs } from '@/lib/server/fsStore'
import { ollamaEmbedding } from '@/lib/server/ollama'
import { retrieveRelevantChunks } from '@/lib/server/ragStore'
import { cosineSimilarity, keywordScore } from '@/lib/server/text'
import { enforceApiSecurity } from '@/lib/server/security'

export const runtime = 'nodejs'

type BenchmarkQuality = {
  overall: number
  relevance: number
  grounding: number
  citations: number
  completeness: number
}

type BenchmarkResult = {
  model: string
  status: 'ok' | 'error'
  latency_ms: number
  quality: BenchmarkQuality
  response_text: string
  citations: Array<{ title: string; venue: string; year: string }>
  suggested_followups: string[]
  error?: string
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function lexicalJaccard(a: string, b: string): number {
  const aTerms = new Set(
    a
      .toLowerCase()
      .split(/\W+/)
      .filter(term => term.length > 2)
      .slice(0, 240)
  )
  const bTerms = new Set(
    b
      .toLowerCase()
      .split(/\W+/)
      .filter(term => term.length > 2)
      .slice(0, 240)
  )

  if (!aTerms.size || !bTerms.size) return 0

  let intersection = 0
  for (const term of aTerms) {
    if (bTerms.has(term)) intersection += 1
  }
  const union = aTerms.size + bTerms.size - intersection
  if (!union) return 0
  return intersection / union
}

function computeCompletenessScore(text: string): number {
  const length = text.trim().length
  if (!length) return 0
  if (length < 180) return clamp01(length / 180)
  if (length <= 1800) return 1
  if (length >= 3200) return clamp01(3200 / length)
  const overflow = (length - 1800) / 1400
  return clamp01(1 - overflow * 0.3)
}

function computeRelevance(params: {
  query: string
  answer: string
  queryEmbedding: number[] | null
  answerEmbedding: number[] | null
}): number {
  const { query, answer, queryEmbedding, answerEmbedding } = params
  if (queryEmbedding && answerEmbedding && queryEmbedding.length === answerEmbedding.length) {
    return clamp01(cosineSimilarity(queryEmbedding, answerEmbedding))
  }

  const keyword = clamp01(keywordScore(query, answer) * 6)
  const jaccard = lexicalJaccard(query, answer)
  return clamp01(keyword * 0.7 + jaccard * 0.3)
}

function computeGrounding(params: {
  answer: string
  answerEmbedding: number[] | null
  contextChunks: Array<{ text: string; embedding?: number[] }>
}): number {
  const { answer, answerEmbedding, contextChunks } = params
  if (!answer.trim() || !contextChunks.length) return 0

  if (answerEmbedding) {
    let best = 0
    for (const chunk of contextChunks) {
      if (Array.isArray(chunk.embedding) && chunk.embedding.length === answerEmbedding.length) {
        const score = clamp01(cosineSimilarity(answerEmbedding, chunk.embedding))
        if (score > best) best = score
      }
    }
    if (best > 0) return best
  }

  let bestLexical = 0
  for (const chunk of contextChunks) {
    const lexical = clamp01(keywordScore(answer, chunk.text) * 8)
    const jaccard = lexicalJaccard(answer, chunk.text)
    const score = clamp01(lexical * 0.6 + jaccard * 0.4)
    if (score > bestLexical) bestLexical = score
  }
  return bestLexical
}

function computeQuality(params: {
  query: string
  answer: string
  queryEmbedding: number[] | null
  answerEmbedding: number[] | null
  contextChunks: Array<{ text: string; embedding?: number[] }>
  citationCount: number
}): BenchmarkQuality {
  const relevance = computeRelevance({
    query: params.query,
    answer: params.answer,
    queryEmbedding: params.queryEmbedding,
    answerEmbedding: params.answerEmbedding,
  })
  const grounding = computeGrounding({
    answer: params.answer,
    answerEmbedding: params.answerEmbedding,
    contextChunks: params.contextChunks,
  })
  const citations = clamp01(Math.min(params.citationCount, 3) / 3)
  const completeness = computeCompletenessScore(params.answer)
  const overall = clamp01(
    grounding * 0.45
      + relevance * 0.35
      + citations * 0.1
      + completeness * 0.1
  )

  return {
    overall: round3(overall),
    relevance: round3(relevance),
    grounding: round3(grounding),
    citations: round3(citations),
    completeness: round3(completeness),
  }
}

function parseModels(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const models: string[] = []
  const seen = new Set<string>()

  for (const raw of input) {
    const model = String(raw || '').trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
    if (models.length >= 5) break
  }

  return models
}

export async function POST(request: NextRequest) {
  const securityError = enforceApiSecurity(request, {
    routeId: 'model-benchmark',
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_BENCHMARK_MAX || '30', 10),
    windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
  })
  if (securityError) return securityError

  try {
    await ensureDataDirs()
    const body = await request.json()

    const message = String(body?.message || '').trim()
    const models = parseModels(body?.models)
    const ragId = String(body?.rag_id || DEFAULT_RAG_ID)
    const topK = Math.max(
      1,
      Math.min(12, Math.floor(toFiniteNumber(body?.top_k) ?? DEFAULT_RAG_TOP_K))
    )
    const temperature = toFiniteNumber(body?.temperature) ?? Number.parseFloat(process.env.BENCHMARK_TEMPERATURE || '0.2')
    const topP = toFiniteNumber(body?.top_p) ?? Number.parseFloat(process.env.BENCHMARK_TOP_P || '0.9')

    if (!message) {
      return NextResponse.json(
        { success: false, error: 'message is required' },
        { status: 400 }
      )
    }

    if (models.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Provide at least 2 models in models[] for A/B testing' },
        { status: 400 }
      )
    }

    const contextChunks = await retrieveRelevantChunks({
      ragId,
      query: message,
      topK,
    })

    const queryEmbedding = await ollamaEmbedding(message)
    const results: BenchmarkResult[] = []

    for (const model of models) {
      const startedAt = Date.now()

      try {
        const response = await executeAgent({
          message,
          agent_id: String(body?.agent_id || 'research-twin-benchmark'),
          user_id: String(body?.user_id || 'benchmark-user'),
          session_id: String(body?.session_id || `benchmark-${crypto.randomUUID().slice(0, 12)}`),
          rag_id: ragId,
          chatModel: model,
          temperature,
          topP,
          topK,
        })
        const latencyMs = Date.now() - startedAt
        const answer = String(response?.result?.response_text || '').trim()
        const answerEmbedding = answer ? await ollamaEmbedding(answer.slice(0, 12000)) : null
        const quality = computeQuality({
          query: message,
          answer,
          queryEmbedding,
          answerEmbedding,
          contextChunks,
          citationCount: Array.isArray(response?.result?.citations) ? response.result.citations.length : 0,
        })

        results.push({
          model,
          status: 'ok',
          latency_ms: latencyMs,
          quality,
          response_text: answer,
          citations: Array.isArray(response?.result?.citations) ? response.result.citations : [],
          suggested_followups: Array.isArray(response?.result?.suggested_followups) ? response.result.suggested_followups : [],
        })
      } catch (error) {
        results.push({
          model,
          status: 'error',
          latency_ms: Date.now() - startedAt,
          quality: {
            overall: 0,
            relevance: 0,
            grounding: 0,
            citations: 0,
            completeness: 0,
          },
          response_text: '',
          citations: [],
          suggested_followups: [],
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const successful = results.filter(item => item.status === 'ok')
    const sortedByQuality = [...successful].sort((a, b) => b.quality.overall - a.quality.overall)
    const sortedByLatency = [...successful].sort((a, b) => a.latency_ms - b.latency_ms)

    return NextResponse.json({
      success: true,
      message,
      rag_id: ragId,
      top_k: topK,
      temperature,
      top_p: topP,
      context_chunks_used: contextChunks.length,
      summary: {
        evaluated_models: results.length,
        successful_models: successful.length,
        failed_models: results.length - successful.length,
        best_quality_model: sortedByQuality[0]?.model || null,
        fastest_model: sortedByLatency[0]?.model || null,
      },
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Server error',
      },
      { status: 500 }
    )
  }
}
