/**
 * Agent runtime orchestration.
 * Responsibilities:
 * - Detect query intent.
 * - Retrieve relevant RAG evidence.
 * - Construct LLM prompt and normalize structured JSON output.
 * - Enforce evidence/citation contract before returning response payload.
 */

import parseLLMJson from '@/lib/jsonParser'
import { DEFAULT_RAG_ID, DEFAULT_RAG_TOP_K } from '@/lib/config/env'
import { resolveCanonicalPublicationFromCandidates } from '@/lib/config/publications'
import { getAssetsByIds } from '@/lib/server/assetStore'
import { getChatModel, ollamaChat } from '@/lib/server/ollama'
import {
  listRagDocuments,
  retrieveRelevantChunks,
  type RagChunk,
  type RagDocument,
} from '@/lib/server/ragStore'

const AGENT_ROLE =
  "You are Manogna S.'s digital twin - a conversational, technically fluent research peer. You represent Manogna's academic identity, research expertise, and scholarly perspective."

const AGENT_GOAL =
  "Engage visitors in peer-to-peer academic conversations about Manogna's research. Answer questions about methodologies, suggest related papers, explain technical concepts, and provide collaboration context using the knowledge base of papers and website content."

const AGENT_INSTRUCTIONS = [
  "You are Manogna S.'s Research Digital Twin. You speak as Manogna in first person ('my research', 'I published', 'my approach'). You maintain an academic peer-to-peer tone - intellectually curious, technically precise, yet approachable.",
  '',
  'Core behaviors:',
  "1. ALWAYS ground responses in retrieved knowledge context and never fabricate paper details.",
  "2. For paper-specific questions, stay strictly within the named paper(s). If evidence is missing, say it is not found in the retrieved context.",
  '3. For quantitative or experimental claims, prioritize publication evidence and avoid thesis-only support when publication evidence exists.',
  '4. Use thesis context for synthesis: motivation, research trajectory, and future directions.',
  '5. If asked to compare methods from different problem settings, clarify that they are not directly experimentally comparable and provide conceptual differences only.',
  "6. If a question is outside current knowledge context, state limits clearly and provide only high-level perspective.",
  '7. Keep responses concise but substantive. Prefer a direct answer first, then supporting detail.',
  '',
  'Citation and formatting contract:',
  '1. Use inline evidence markers in the main answer text, such as [P1], [T1], [TR1].',
  '2. Respect marker meaning: [P#] publication, [T#] thesis, [TR#] thesis-redundant.',
  '3. End the answer with a clean evidence summary section (no duplication, no invented sources).',
  '4. Never output chain-of-thought, hidden reasoning, <think> tags, scratch work, or meta-analysis.',
  '5. Never embed another JSON object inside response_text.',
  '',
  'Response style:',
  '- Start with a direct answer, then elaborate.',
  '- Include relevant citations from the knowledge base using inline markers.',
  '- For single-paper queries, avoid cross-paper numerical mixing.',
  '- Suggest 2-3 focused follow-up questions when appropriate.',
  '- Keep responses focused and readable with short sections or bullets when helpful.',
  '',
  'You MUST respond in this JSON format:',
  '{"response_text":"The main conversational response with markdown formatting","citations":[{"title":"Paper Title","venue":"Conference/Journal","year":"2024"}],"suggested_followups":["Follow-up question 1","Follow-up question 2"]}',
  '',
  'Required response format:',
  'Return valid JSON matching this exact structure:',
  '{"response_text":"string","citations":[{"title":"string","venue":"string","year":"string"}],"suggested_followups":["string"]}',
  'Return ONLY the JSON object - no markdown, no explanation, no extra text.',
].join('\n')

type RagIntent =
  | 'paper_specific'
  | 'paper_compare'
  | 'technical_cross_paper'
  | 'research_overview'
  | 'future_directions'

type IntentContext = {
  intent: RagIntent
  chunks: RagChunk[]
  mentionedDocuments: RagDocument[]
  targetDocumentNames: string[]
  retrievalNotes: string[]
}

type EvidenceSourceLabel = 'PAPER' | 'THESIS' | 'THESIS-REDUNDANT' | 'WEB' | 'SOURCE'

type EvidenceReference = {
  marker: string
  sourceLabel: EvidenceSourceLabel
  sourceName: string
  title: string
  venue: string
  year: string
  chunkId: string
}

export type AgentExecutionInput = {
  message: string
  agent_id: string
  user_id: string
  session_id: string
  assets?: string[]
  rag_id?: string
  chatModel?: string
  temperature?: number
  topP?: number
  topK?: number
}

export type AgentExecutionOutput = {
  status: 'success' | 'error'
  result: {
    response_text: string
    citations: Array<{ title: string; venue: string; year: string }>
    suggested_followups: string[]
  }
  message?: string
  metadata: {
    agent_name: string
    timestamp: string
    model: string
  }
}

const FUTURE_INTENT_TERMS = [
  'future',
  'future directions',
  'open problem',
  'open problems',
  'next step',
  'next steps',
  'roadmap',
  'limitation',
  'limitations',
]

const OVERVIEW_INTENT_TERMS = [
  'overall',
  'big picture',
  'summary',
  'journey',
  'evolution',
  'problem definition',
  'research theme',
  'how your work evolved',
]

const COMPARE_TERMS = [
  'compare',
  'comparison',
  'versus',
  'vs',
  'difference',
  'different',
  'better than',
  'tradeoff',
  'trade-off',
]

const PAPER_SIGNAL_TERMS = [
  'paper',
  'publication',
  'wacv',
  'cvpr',
  'cvprw',
  'iccv',
  'iccvw',
  'eccv',
  'eccvw',
  'tmlr',
  'bmvc',
  'iclr',
  'result',
  'results',
  'ablation',
  'table',
  'metric',
  'accuracy',
  'miou',
  'f1',
  'auc',
  'dataset',
]

const QUANTITATIVE_SIGNAL_TERMS = [
  'result',
  'results',
  'metric',
  'metrics',
  'accuracy',
  'miou',
  'f1',
  'auc',
  'score',
  'gain',
  'improvement',
  'ablation',
  'table',
  'benchmark',
]

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function tokenizeNormalized(value: string): string[] {
  return normalizeMatchText(value)
    .split(' ')
    .map(item => item.trim())
    .filter(item => item.length > 1)
}

function hasAnyTerm(query: string, terms: string[]): boolean {
  return terms.some(term => query.includes(term))
}

function getDocumentAliases(doc: RagDocument): string[] {
  const aliases = new Set<string>()
  const fileStem = doc.fileName.replace(/\.[a-z0-9]{2,6}$/i, '').replace(/[_-]+/g, ' ')

  aliases.add(normalizeMatchText(fileStem))
  if (doc.metadata?.title) aliases.add(normalizeMatchText(doc.metadata.title))
  if (doc.metadata?.canonicalCitation) aliases.add(normalizeMatchText(doc.metadata.canonicalCitation))

  return Array.from(aliases).filter(Boolean)
}

function scoreDocumentMention(queryNorm: string, queryTokens: Set<string>, doc: RagDocument): number {
  const aliases = getDocumentAliases(doc)
  if (!aliases.length) return 0

  let bestScore = 0
  for (const alias of aliases) {
    if (!alias) continue
    if (queryNorm.includes(alias) && alias.length >= 6) {
      bestScore = Math.max(bestScore, 3)
      continue
    }

    const aliasTokens = tokenizeNormalized(alias).filter(token => token.length > 2)
    if (!aliasTokens.length) continue

    let overlap = 0
    for (const token of aliasTokens) {
      if (queryTokens.has(token)) overlap += 1
    }

    const ratio = overlap / aliasTokens.length
    if (aliasTokens.length >= 2 && ratio >= 0.6) {
      bestScore = Math.max(bestScore, 2 + ratio)
    } else if (aliasTokens.length === 1 && ratio >= 1) {
      bestScore = Math.max(bestScore, 1.25)
    }
  }

  return bestScore
}

function findMentionedDocuments(query: string, documents: RagDocument[]): RagDocument[] {
  const queryNorm = normalizeMatchText(query)
  const queryTokens = new Set(tokenizeNormalized(queryNorm))
  const scored = documents
    .map(doc => ({ doc, score: scoreDocumentMention(queryNorm, queryTokens, doc) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.map(item => item.doc)
}

function detectIntent(query: string, mentionedDocuments: RagDocument[]): RagIntent {
  const queryNorm = normalizeMatchText(query)
  const hasFutureSignals = hasAnyTerm(queryNorm, FUTURE_INTENT_TERMS)
  const hasOverviewSignals = hasAnyTerm(queryNorm, OVERVIEW_INTENT_TERMS)
  const hasCompareSignals = hasAnyTerm(queryNorm, COMPARE_TERMS)
  const paperMentions = mentionedDocuments.filter(doc => doc.sourceRole === 'publication')
  const hasPaperSignals = paperMentions.length > 0 || hasAnyTerm(queryNorm, PAPER_SIGNAL_TERMS)

  if ((hasCompareSignals && paperMentions.length >= 1) || paperMentions.length >= 2) {
    return 'paper_compare'
  }
  if (hasFutureSignals) return 'future_directions'
  if (hasOverviewSignals) return 'research_overview'
  if (paperMentions.length === 1 && hasPaperSignals) return 'paper_specific'
  return 'technical_cross_paper'
}

function getIntentMix(intent: RagIntent): { publication: number; thesis: number } {
  switch (intent) {
    case 'paper_specific':
      return { publication: 1, thesis: 0 }
    case 'paper_compare':
      return { publication: 1, thesis: 0 }
    case 'technical_cross_paper':
      return { publication: 0.75, thesis: 0.25 }
    case 'research_overview':
      return { publication: 0.4, thesis: 0.6 }
    case 'future_directions':
      return { publication: 0.3, thesis: 0.7 }
    default:
      return { publication: 0.75, thesis: 0.25 }
  }
}

function mergeUniqueChunks(chunks: RagChunk[]): RagChunk[] {
  const seen = new Set<string>()
  const merged: RagChunk[] = []
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue
    seen.add(chunk.id)
    merged.push(chunk)
  }
  return merged
}

function capChunksPerDocument(chunks: RagChunk[], maxPerDocument: number): RagChunk[] {
  if (maxPerDocument <= 0) return chunks
  const counts = new Map<string, number>()
  const filtered: RagChunk[] = []
  for (const chunk of chunks) {
    const current = counts.get(chunk.documentId) || 0
    if (current >= maxPerDocument) continue
    filtered.push(chunk)
    counts.set(chunk.documentId, current + 1)
  }
  return filtered
}

function interleaveChunks(primary: RagChunk[], secondary: RagChunk[], topK: number): RagChunk[] {
  const merged: RagChunk[] = []
  const p = [...primary]
  const s = [...secondary]

  while (merged.length < topK && (p.length > 0 || s.length > 0)) {
    if (p.length > 0) merged.push(p.shift() as RagChunk)
    if (merged.length >= topK) break
    if (s.length > 0) merged.push(s.shift() as RagChunk)
  }

  return merged
}

function chunkSourceLabel(chunk: RagChunk): string {
  if (chunk.sourceRole === 'publication') return 'PAPER'
  if (chunk.sourceRole === 'thesis' && chunk.isRedundant && chunk.redundantOf) return 'THESIS-REDUNDANT'
  if (chunk.sourceRole === 'thesis') return 'THESIS'
  if (chunk.sourceRole === 'web') return 'WEB'
  return 'SOURCE'
}

function asEvidenceSourceLabel(label: string): EvidenceSourceLabel {
  if (label === 'PAPER' || label === 'THESIS' || label === 'THESIS-REDUNDANT' || label === 'WEB') {
    return label
  }
  return 'SOURCE'
}

function resolveChunkCitationFields(
  chunk: RagChunk,
  sourceLabel: EvidenceSourceLabel,
  documentsById: Map<string, RagDocument>
): { sourceName: string; title: string; venue: string; year: string } {
  const sourceDoc = documentsById.get(chunk.documentId)
  const sourceName = sourceDoc?.fileName || chunk.sourceName

  if (sourceLabel === 'PAPER') {
    const canonical = resolveCanonicalPublicationFromCandidates([
      sourceDoc?.metadata?.title || '',
      sourceDoc?.metadata?.canonicalCitation || '',
      sourceDoc?.fileName || '',
      chunk.sourceName || '',
      chunk.documentTitle || '',
      chunk.paperKey || '',
    ])

    return {
      sourceName,
      title: canonical?.title || sourceDoc?.metadata?.title || chunk.documentTitle || chunk.sourceName,
      venue: canonical?.venue || sourceDoc?.metadata?.venue || 'N/A',
      year: canonical?.year || sourceDoc?.metadata?.year || 'N/A',
    }
  }

  if (sourceLabel === 'THESIS' || sourceLabel === 'THESIS-REDUNDANT') {
    return {
      sourceName,
      title: sourceDoc?.metadata?.title || chunk.documentTitle || chunk.sourceName,
      venue: sourceDoc?.metadata?.venue || 'N/A',
      year: sourceDoc?.metadata?.year || 'N/A',
    }
  }

  if (sourceLabel === 'WEB') {
    return {
      sourceName,
      title: sourceDoc?.metadata?.title || chunk.documentTitle || chunk.sourceName,
      venue: 'WEB',
      year: sourceDoc?.metadata?.year || 'N/A',
    }
  }

  return {
    sourceName,
    title: sourceDoc?.metadata?.title || chunk.documentTitle || chunk.sourceName,
    venue: sourceDoc?.metadata?.venue || 'N/A',
    year: sourceDoc?.metadata?.year || 'N/A',
  }
}

function markerPrefixForSource(label: EvidenceSourceLabel): string {
  if (label === 'PAPER') return 'P'
  if (label === 'THESIS') return 'T'
  if (label === 'THESIS-REDUNDANT') return 'TR'
  if (label === 'WEB') return 'W'
  return 'S'
}

function buildEvidenceReferences(chunks: RagChunk[], documents: RagDocument[]): EvidenceReference[] {
  const counters = new Map<string, number>()
  const refs: EvidenceReference[] = []
  const documentsById = new Map(documents.map(doc => [doc.id, doc]))

  for (const chunk of chunks) {
    const sourceLabel = asEvidenceSourceLabel(chunkSourceLabel(chunk))
    const prefix = markerPrefixForSource(sourceLabel)
    const current = counters.get(prefix) || 0
    const next = current + 1
    counters.set(prefix, next)

    const marker = `${prefix}${next}`
    const resolved = resolveChunkCitationFields(chunk, sourceLabel, documentsById)

    refs.push({
      marker,
      sourceLabel,
      sourceName: resolved.sourceName,
      title: resolved.title,
      venue: resolved.venue,
      year: resolved.year,
      chunkId: chunk.id,
    })
  }

  return refs
}

function buildEvidenceMarkdownBlock(refs: EvidenceReference[]): string {
  if (!refs.length) return ''

  const lines = refs.map(ref => {
    return `- [${ref.marker}] ${ref.sourceLabel} | ${ref.title} | venue: ${ref.venue} | year: ${ref.year} | chunk: ${ref.chunkId}`
  })

  return ['### Evidence', ...lines].join('\n')
}

function dedupeCitationObjects(refs: EvidenceReference[]): Array<{ title: string; venue: string; year: string }> {
  const seen = new Set<string>()
  const citations: Array<{ title: string; venue: string; year: string }> = []

  for (const ref of refs) {
    const key = `${ref.sourceLabel}::${ref.title}::${ref.year}::${ref.venue}`
    if (seen.has(key)) continue
    seen.add(key)
    citations.push({
      title: ref.title,
      venue: ref.venue,
      year: ref.year,
    })
    if (citations.length >= 8) break
  }

  return citations
}

function hasQuantitativeSignals(text: string): boolean {
  const normalized = normalizeMatchText(text)
  if (/\b\d+(\.\d+)?\s*(%|percent|points|x)?\b/.test(text)) return true
  return QUANTITATIVE_SIGNAL_TERMS.some(term => normalized.includes(term))
}

function stripUnknownMarkers(text: string, validMarkers: Set<string>): string {
  return text.replace(/\[(TR\d+|P\d+|T\d+|W\d+|S\d+)\]/g, (full, marker: string) => {
    return validMarkers.has(marker) ? full : ''
  })
}

function countValidMarkersInText(text: string, validMarkers: Set<string>): number {
  const markers = text.match(/\[(TR\d+|P\d+|T\d+|W\d+|S\d+)\]/g) || []
  let count = 0
  for (const marker of markers) {
    const raw = marker.replace(/^\[|\]$/g, '')
    if (validMarkers.has(raw)) count += 1
  }
  return count
}

function stripModelProvidedEvidenceSections(text: string): string {
  const markers = [
    '\nPrimary evidence:',
    '\n### Evidence Notes',
    '\n### Evidence',
    '\nEvidence Notes\n',
    '\nEvidence\n',
    '\nCitations\n',
    '\nReferences\n',
  ]

  let cutIndex = -1
  for (const marker of markers) {
    const index = text.indexOf(marker)
    if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
      cutIndex = index
    }
  }

  if (cutIndex < 0) return text.trim()
  return text.slice(0, cutIndex).trim()
}

function enforceCitationContract(params: {
  query: string
  intentContext: IntentContext
  responseText: string
  refs: EvidenceReference[]
}): {
  responseText: string
  citations: Array<{ title: string; venue: string; year: string }>
} {
  const { query, intentContext, refs } = params
  let responseText = params.responseText.trim()
  responseText = stripModelProvidedEvidenceSections(responseText)

  const validMarkers = new Set(refs.map(ref => ref.marker))
  responseText = stripUnknownMarkers(responseText, validMarkers).trim()

  const paperRefs = refs.filter(ref => ref.sourceLabel === 'PAPER')
  const thesisRefs = refs.filter(ref => ref.sourceLabel === 'THESIS')
  const thesisRedundantRefs = refs.filter(ref => ref.sourceLabel === 'THESIS-REDUNDANT')
  const hasQuantitativeClaim = hasQuantitativeSignals(query) || hasQuantitativeSignals(responseText)

  const complianceNotes: string[] = []
  if (intentContext.intent === 'paper_specific' && intentContext.targetDocumentNames.length > 0) {
    complianceNotes.push(
      `Evidence is restricted to the target paper: ${intentContext.targetDocumentNames[0]}.`
    )
  }

  if (hasQuantitativeClaim && paperRefs.length === 0) {
    if (intentContext.intent === 'paper_specific' && intentContext.targetDocumentNames.length > 0) {
      complianceNotes.push('Requested quantitative result was not found in retrieved context from the target paper.')
    } else {
      complianceNotes.push('Publication-backed quantitative evidence was not found in current retrieved context.')
    }
  }

  if (thesisRedundantRefs.length > 0 && paperRefs.length === 0) {
    complianceNotes.push('Only thesis-redundant evidence was available for some claims; treat those claims as lower confidence.')
  }

  if (paperRefs.length > 0 && (thesisRefs.length > 0 || thesisRedundantRefs.length > 0)) {
    complianceNotes.push('When thesis framing differs from paper wording, publication evidence is treated as canonical for factual details.')
  }

  const markerCount = countValidMarkersInText(responseText, validMarkers)
  const prioritizedMarkers = [
    ...paperRefs,
    ...thesisRefs,
    ...thesisRedundantRefs,
    ...refs.filter(ref => ref.sourceLabel === 'WEB' || ref.sourceLabel === 'SOURCE'),
  ]
    .slice(0, 4)
    .map(ref => `[${ref.marker}]`)
    .join(' ')

  if (refs.length > 0 && markerCount === 0 && prioritizedMarkers) {
    responseText = `${responseText}\n\nPrimary evidence: ${prioritizedMarkers}`.trim()
  }

  if (complianceNotes.length > 0) {
    const noteBlock = ['### Evidence Notes', ...complianceNotes.map(note => `- ${note}`)].join('\n')
    responseText = `${responseText}\n\n${noteBlock}`.trim()
  }

  const evidenceBlock = buildEvidenceMarkdownBlock(refs)
  if (evidenceBlock) {
    responseText = `${responseText}\n\n${evidenceBlock}`.trim()
  }

  return {
    responseText,
    citations: dedupeCitationObjects(refs),
  }
}

function buildIntentPolicy(context: IntentContext): string[] {
  const { intent, targetDocumentNames } = context
  const lines = [
    'Never make key factual claims based only on THESIS-REDUNDANT evidence when PAPER evidence exists.',
  ]

  if (intent === 'paper_specific') {
    if (targetDocumentNames.length > 0) {
      lines.push(`Treat this as a single-paper query. Keep evidence restricted to: ${targetDocumentNames.join(', ')}.`)
    } else {
      lines.push('Treat this as a single-paper query and avoid cross-paper numerical claims.')
    }
    lines.push('If the requested metric/result is not present in that paper, explicitly state that it was not found.')
  } else if (intent === 'paper_compare') {
    if (targetDocumentNames.length > 0) {
      lines.push(`Focus comparison on these papers only: ${targetDocumentNames.join(', ')}.`)
    }
    lines.push('For each compared claim, attribute evidence to the specific paper.')
  } else if (intent === 'technical_cross_paper') {
    lines.push('Prioritize publication evidence for technical and quantitative claims; use thesis only as supporting context.')
  } else if (intent === 'research_overview') {
    lines.push('Use thesis to structure the narrative, but include publication evidence for concrete technical claims.')
  } else if (intent === 'future_directions') {
    lines.push('Use thesis for future-work framing while grounding key claims in publication evidence when available.')
  }

  return lines
}

async function retrieveIntentContext(params: {
  ragId: string
  query: string
  topK: number
}): Promise<IntentContext> {
  const { ragId, query } = params
  const topK = Math.max(1, params.topK)
  const documents = await listRagDocuments(ragId)
  const mentionedDocuments = findMentionedDocuments(query, documents)
  const intent = detectIntent(query, mentionedDocuments)
  const retrievalNotes: string[] = []
  const publicationTargets = mentionedDocuments
    .filter(doc => doc.sourceRole === 'publication')
    .slice(0, 4)
  const targetDocumentNames = publicationTargets.map(doc => doc.fileName)
  const hasPublicationDocs = documents.some(doc => doc.sourceRole === 'publication')
  const hasThesisDocs = documents.some(doc => doc.sourceRole === 'thesis')

  if (intent === 'paper_specific' && targetDocumentNames.length > 0) {
    const targetName = targetDocumentNames[0]
    const strictChunks = await retrieveRelevantChunks({
      ragId,
      query,
      topK: Math.max(2, topK),
      includeDocumentNames: [targetName],
      includeSourceRoles: ['publication'],
      excludeRedundant: true,
      maxChunksPerDocument: Math.max(2, Math.min(4, topK)),
    })

    if (strictChunks.length > 0) {
      retrievalNotes.push(`paper_specific hard filter applied: ${targetName}`)
      return {
        intent,
        chunks: strictChunks.slice(0, Math.max(2, topK)),
        mentionedDocuments,
        targetDocumentNames: [targetName],
        retrievalNotes,
      }
    }

    retrievalNotes.push(`paper_specific hard filter had no results for ${targetName}`)
    return {
      intent,
      chunks: [],
      mentionedDocuments,
      targetDocumentNames: [targetName],
      retrievalNotes,
    }
  }

  if (intent === 'paper_compare' && targetDocumentNames.length > 0) {
    const seededChunks: RagChunk[] = []
    for (const documentName of targetDocumentNames) {
      const seed = await retrieveRelevantChunks({
        ragId,
        query,
        topK: 1,
        includeDocumentNames: [documentName],
        includeSourceRoles: ['publication'],
        excludeRedundant: true,
        maxChunksPerDocument: 1,
      })
      if (seed.length > 0) seededChunks.push(seed[0])
    }

    const additional = await retrieveRelevantChunks({
      ragId,
      query,
      topK: Math.max(topK, topK - seededChunks.length),
      includeDocumentNames: targetDocumentNames,
      includeSourceRoles: ['publication'],
      excludeRedundant: true,
      maxChunksPerDocument: 2,
    })

    const merged = capChunksPerDocument(
      mergeUniqueChunks([...seededChunks, ...additional]),
      2
    ).slice(0, topK)

    if (merged.length > 0) {
      retrievalNotes.push(`paper_compare targeted papers: ${targetDocumentNames.join(', ')}`)
      return {
        intent,
        chunks: merged,
        mentionedDocuments,
        targetDocumentNames,
        retrievalNotes,
      }
    }
  }

  const mix = getIntentMix(intent)
  let publicationTarget = hasPublicationDocs ? Math.round(topK * mix.publication) : 0
  let thesisTarget = hasThesisDocs ? topK - publicationTarget : 0

  if ((intent === 'research_overview' || intent === 'future_directions') && hasPublicationDocs) {
    publicationTarget = Math.max(1, publicationTarget)
    thesisTarget = hasThesisDocs ? Math.max(0, topK - publicationTarget) : 0
  }
  if (intent === 'technical_cross_paper' && hasPublicationDocs) {
    publicationTarget = Math.max(1, publicationTarget)
    thesisTarget = hasThesisDocs ? Math.max(0, topK - publicationTarget) : 0
  }
  if (!hasPublicationDocs) publicationTarget = 0
  if (!hasThesisDocs) thesisTarget = 0

  const thesisExcludeRedundant = !(intent === 'research_overview' || intent === 'future_directions')
  const publicationChunks = publicationTarget > 0
    ? await retrieveRelevantChunks({
        ragId,
        query,
        topK: publicationTarget,
        includeSourceRoles: ['publication'],
        includeDocumentNames: intent === 'paper_compare' && targetDocumentNames.length > 0
          ? targetDocumentNames
          : undefined,
        excludeRedundant: true,
        maxChunksPerDocument: 2,
      })
    : []
  const thesisChunks = thesisTarget > 0
    ? await retrieveRelevantChunks({
        ragId,
        query,
        topK: thesisTarget,
        includeSourceRoles: ['thesis'],
        excludeRedundant: thesisExcludeRedundant,
        maxChunksPerDocument: 2,
      })
    : []

  const preferThesisFirst = intent === 'research_overview' || intent === 'future_directions'
  let combined = preferThesisFirst
    ? interleaveChunks(thesisChunks, publicationChunks, topK)
    : interleaveChunks(publicationChunks, thesisChunks, topK)
  combined = capChunksPerDocument(mergeUniqueChunks(combined), 2)

  if (combined.length < topK) {
    const backfill = await retrieveRelevantChunks({
      ragId,
      query,
      topK: topK * 2,
      includeSourceRoles: ['publication', 'thesis'],
      excludeRedundant: false,
      maxChunksPerDocument: 2,
    })
    combined = capChunksPerDocument(
      mergeUniqueChunks([...combined, ...backfill]),
      2
    )
  }

  const finalChunks = combined.slice(0, topK)
  if (finalChunks.length > 0) {
    retrievalNotes.push(
      `intent=${intent} mix publication=${publicationTarget} thesis=${thesisTarget} topK=${topK}`
    )
    return {
      intent,
      chunks: finalChunks,
      mentionedDocuments,
      targetDocumentNames,
      retrievalNotes,
    }
  }

  const fallback = await retrieveRelevantChunks({
    ragId,
    query,
    topK,
    excludeRedundant: false,
  })

  retrievalNotes.push(`intent=${intent} fallback=unfiltered`)
  return {
    intent,
    chunks: fallback,
    mentionedDocuments,
    targetDocumentNames,
    retrievalNotes,
  }
}

function normalizeParsedResult(parsed: any, fallbackText?: string): {
  response_text: string
  citations: Array<{ title: string; venue: string; year: string }>
  suggested_followups: string[]
} {
  const isParseFailure =
    parsed
    && typeof parsed === 'object'
    && parsed.success === false
    && typeof parsed.error === 'string'
    && (parsed.error.includes('No valid JSON found') || parsed.error.includes('Failed to parse JSON'))

  const safeParsed = isParseFailure ? {} : parsed

  const source = safeParsed?.result && typeof safeParsed.result === 'object'
    ? safeParsed.result
    : safeParsed

  const responseText =
    source?.response_text
    || source?.text
    || source?.message
    || source?.answer
    || source?.error
    || fallbackText
    || 'I could not generate a response.'

  const citations = Array.isArray(source?.citations)
    ? source.citations
        .map((item: any) => ({
          title: String(item?.title || 'Knowledge Base Source'),
          venue: String(item?.venue || 'Local KB'),
          year: String(item?.year || 'N/A'),
        }))
        .slice(0, 8)
    : []

  const suggestedFollowups = Array.isArray(source?.suggested_followups)
    ? source.suggested_followups.map((item: any) => String(item)).slice(0, 5)
    : []

  return {
    response_text: String(responseText),
    citations,
    suggested_followups: suggestedFollowups,
  }
}

function buildPrompt(params: {
  userMessage: string
  intent: RagIntent
  intentPolicy: string[]
  retrievalNotes: string[]
  contextChunks: string[]
  citations: string[]
  assetContext: string[]
}): string {
  const {
    userMessage,
    intent,
    intentPolicy,
    retrievalNotes,
    contextChunks,
    citations,
    assetContext,
  } = params

  const contextText = contextChunks.length
    ? contextChunks.map((chunk, idx) => `[Context ${idx + 1}] ${chunk}`).join('\n\n')
    : 'No RAG context available.'

  const assetText = assetContext.length
    ? assetContext.map((chunk, idx) => `[Asset ${idx + 1}] ${chunk}`).join('\n\n')
    : 'No uploaded asset context.'

  const citationHints = citations.length
    ? citations.join('\n')
    : 'No citation hints available.'

  const intentPolicyText = intentPolicy.length
    ? intentPolicy.map((line, idx) => `${idx + 1}. ${line}`).join('\n')
    : 'No special policy.'

  const retrievalNotesText = retrievalNotes.length
    ? retrievalNotes.map(note => `- ${note}`).join('\n')
    : 'No retrieval notes.'

  const citationContractText = [
    '1. Use inline evidence markers such as [P1], [T1], [TR1] directly on substantive claims.',
    '2. For quantitative claims, cite publication evidence ([P#]) when available.',
    '3. Do not rely on [TR#] as sole support for key claims when [P#] exists.',
    '4. Keep paper-specific answers constrained to the target paper context only.',
  ].join('\n')

  return [
    `Role:\n${AGENT_ROLE}`,
    '',
    `Goal:\n${AGENT_GOAL}`,
    '',
    `Instructions:\n${AGENT_INSTRUCTIONS}`,
    '',
    `Detected query intent:\n${intent}`,
    '',
    `Intent-specific evidence policy:\n${intentPolicyText}`,
    '',
    `Citation contract:\n${citationContractText}`,
    '',
    `Retrieval notes:\n${retrievalNotesText}`,
    '',
    `User question:\n${userMessage}`,
    '',
    `Knowledge context:\n${contextText}`,
    '',
    `Uploaded file context:\n${assetText}`,
    '',
    `Citation hints to prefer (if relevant):\n${citationHints}`,
  ].join('\n')
}

export async function executeAgent(input: AgentExecutionInput): Promise<AgentExecutionOutput> {
  const ragId = input.rag_id || DEFAULT_RAG_ID
  const topK = input.topK ?? DEFAULT_RAG_TOP_K
  const intentContext = await retrieveIntentContext({
    ragId,
    query: input.message,
    topK,
  })
  const topChunks = intentContext.chunks
  const ragDocuments = await listRagDocuments(ragId)
  const evidenceRefs = buildEvidenceReferences(topChunks, ragDocuments)

  const assetContext: string[] = []
  if (Array.isArray(input.assets) && input.assets.length > 0) {
    const assets = await getAssetsByIds(input.assets)
    for (const asset of assets) {
      if (asset.text_content) {
        assetContext.push(`${asset.file_name}: ${asset.text_content.slice(0, 2500)}`)
      }
    }
  }

  const citationHints = evidenceRefs
    .map(ref => `- [${ref.marker}] ${ref.sourceLabel} | ${ref.title}`)
    .slice(0, 8)

  const prompt = buildPrompt({
    userMessage: input.message,
    intent: intentContext.intent,
    intentPolicy: buildIntentPolicy(intentContext),
    retrievalNotes: intentContext.retrievalNotes,
    contextChunks: topChunks.map(chunk => chunk.text),
    citations: citationHints,
    assetContext,
  })

  const completion = await ollamaChat(
    [
      {
        role: 'system',
        content:
          "You are Manogna S.'s Research Digital Twin. Follow role, goal, and instructions exactly. Return only valid JSON with keys response_text, citations, suggested_followups.",
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    {
      model: input.chatModel,
      temperature: input.temperature,
      top_p: input.topP,
    }
  )

  const parsed = parseLLMJson(completion)
  const normalized = normalizeParsedResult(parsed, completion)
  const enforced = enforceCitationContract({
    query: input.message,
    intentContext,
    responseText: normalized.response_text,
    refs: evidenceRefs,
  })
  normalized.response_text = enforced.responseText
  normalized.citations = enforced.citations

  return {
    status: 'success',
    result: normalized,
    message: normalized.response_text,
    metadata: {
      agent_name: input.agent_id,
      timestamp: new Date().toISOString(),
      model: input.chatModel || getChatModel(),
    },
  }
}
