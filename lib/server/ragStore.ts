/**
 * Local JSON-backed RAG storage layer.
 * Responsibilities:
 * - Persist document and chunk records.
 * - Ingest and embed uploaded/crawled text.
 * - Retrieve relevant chunks with configurable filters.
 * - Track thesis redundancy against publication chunks.
 */

import { readJsonFile, resolveDataPath, writeJsonFileAtomic } from '@/lib/server/fsStore'
import { DEFAULT_RAG_TOP_K } from '@/lib/config/env'
import { ollamaEmbedding } from '@/lib/server/ollama'
import { chunkText, cosineSimilarity, keywordScore } from '@/lib/server/text'
import { createHash } from 'crypto'

export type RagSourceRole = 'publication' | 'thesis' | 'web' | 'other'

export type RagDocumentMetadata = {
  title?: string
  year?: string
  venue?: string
  chapter?: string
  section?: string
  subsection?: string
  topics?: string[]
  canonicalCitation?: string
}

export type RagDocument = {
  id: string
  ragId: string
  fileName: string
  fileType: 'pdf' | 'docx' | 'txt'
  status: 'active' | 'failed' | 'deleted'
  uploadedAt: string
  sourceType: 'upload' | 'crawl'
  sourceRef?: string
  documentCount: number
  sourceRole: RagSourceRole
  metadata?: RagDocumentMetadata
}

export type RagChunk = {
  id: string
  ragId: string
  documentId: string
  text: string
  textHash?: string
  embedding?: number[]
  sourceName: string
  chunkIndex: number
  sourceRole: RagSourceRole
  paperKey?: string
  documentTitle?: string
  headingPath?: string
  pageStart?: number
  pageEnd?: number
  redundantOf?: string
  redundancyScore?: number
  isRedundant?: boolean
}

type RagStore = {
  documents: RagDocument[]
  chunks: RagChunk[]
}

const RAG_STORE_PATH = resolveDataPath('rag', 'store.json')

function normalizeTextForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function getTextHash(text: string): string {
  return createHash('sha1').update(normalizeTextForHash(text)).digest('hex')
}

function normalizeSourceRole(value: unknown, fallback: RagSourceRole = 'other'): RagSourceRole {
  if (value === 'publication' || value === 'thesis' || value === 'web' || value === 'other') {
    return value
  }
  return fallback
}

function inferSourceRole(fileName: string, sourceType: 'upload' | 'crawl'): RagSourceRole {
  if (sourceType === 'crawl') return 'web'
  if (/thesis|dissertation/i.test(fileName)) return 'thesis'
  return 'publication'
}

function normalizeTextField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

function normalizeTopics(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map(item => normalizeTextField(item))
    .filter((item): item is string => Boolean(item))
  return normalized.length ? normalized : undefined
}

function normalizeMetadata(metadata: unknown): RagDocumentMetadata | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const value = metadata as Record<string, unknown>
  const normalized: RagDocumentMetadata = {
    title: normalizeTextField(value.title),
    year: normalizeTextField(value.year),
    venue: normalizeTextField(value.venue),
    chapter: normalizeTextField(value.chapter),
    section: normalizeTextField(value.section),
    subsection: normalizeTextField(value.subsection),
    topics: normalizeTopics(value.topics),
    canonicalCitation: normalizeTextField(value.canonicalCitation),
  }

  if (
    !normalized.title
    && !normalized.year
    && !normalized.venue
    && !normalized.chapter
    && !normalized.section
    && !normalized.subsection
    && !normalized.topics?.length
    && !normalized.canonicalCitation
  ) {
    return undefined
  }

  return normalized
}

function normalizePaperKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,6}$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function resolvePaperKey(fileName: string, metadata?: RagDocumentMetadata): string | undefined {
  const base = metadata?.title || fileName
  const key = normalizePaperKey(base)
  return key.length ? key : undefined
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function toWordFiveGrams(text: string): Set<string> {
  const terms = text
    .toLowerCase()
    .split(/\W+/)
    .map(item => item.trim())
    .filter(item => item.length > 1)

  if (terms.length < 5) {
    return new Set(terms.length ? [terms.join(' ')] : [])
  }

  const grams = new Set<string>()
  for (let i = 0; i <= terms.length - 5; i++) {
    grams.add(terms.slice(i, i + 5).join(' '))
  }
  return grams
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  if (!union) return 0
  return intersection / union
}

function lexicalOverlapScore(a: string, b: string): number {
  return jaccard(toWordFiveGrams(a), toWordFiveGrams(b))
}

function normalizeSentence(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]\s+|\n+/)
    .map(item => normalizeSentence(item))
    .filter(item => item.length >= 20)
}

function novelSentenceRatio(thesisText: string, publicationText: string): number {
  const thesisSentences = splitSentences(thesisText)
  if (!thesisSentences.length) return 0

  const publicationSentenceSet = new Set(splitSentences(publicationText))
  let novelCount = 0
  for (const sentence of thesisSentences) {
    if (!publicationSentenceSet.has(sentence)) {
      novelCount += 1
    }
  }
  return novelCount / thesisSentences.length
}

function getDedupConfig() {
  const cosine = Number.parseFloat(process.env.RAG_DEDUP_COSINE_THRESHOLD || '0.96')
  const lexical = Number.parseFloat(process.env.RAG_DEDUP_LEXICAL_THRESHOLD || '0.85')
  const novel = Number.parseFloat(process.env.RAG_DEDUP_NOVEL_SENTENCE_THRESHOLD || '0.2')

  return {
    cosineThreshold: clamp01(cosine),
    lexicalThreshold: clamp01(lexical),
    novelSentenceThreshold: clamp01(novel),
  }
}

function getRedundantThesisPenalty(): number {
  const value = Number.parseFloat(process.env.RAG_REDUNDANT_THESIS_PENALTY || '0.08')
  return clamp01(value)
}

function annotateThesisRedundancy(store: RagStore, ragId: string): void {
  const { cosineThreshold, lexicalThreshold, novelSentenceThreshold } = getDedupConfig()
  const publicationChunks = store.chunks.filter(chunk => chunk.ragId === ragId && chunk.sourceRole === 'publication')
  const thesisChunks = store.chunks.filter(chunk => chunk.ragId === ragId && chunk.sourceRole === 'thesis')
  if (!thesisChunks.length) return

  const publicationByHash = new Map<string, RagChunk[]>()
  for (const publicationChunk of publicationChunks) {
    const hash = publicationChunk.textHash || getTextHash(publicationChunk.text)
    publicationChunk.textHash = hash
    const bucket = publicationByHash.get(hash)
    if (bucket) {
      bucket.push(publicationChunk)
    } else {
      publicationByHash.set(hash, [publicationChunk])
    }
  }

  for (const thesisChunk of thesisChunks) {
    thesisChunk.textHash = thesisChunk.textHash || getTextHash(thesisChunk.text)
    thesisChunk.isRedundant = false
    thesisChunk.redundantOf = undefined
    thesisChunk.redundancyScore = undefined

    if (!publicationChunks.length) continue

    const exactMatches = publicationByHash.get(thesisChunk.textHash) || []
    if (exactMatches.length > 0) {
      const exactMatch = exactMatches[0]
      const novelRatio = novelSentenceRatio(thesisChunk.text, exactMatch.text)
      if (novelRatio < novelSentenceThreshold) {
        thesisChunk.isRedundant = true
        thesisChunk.redundantOf = exactMatch.id
        thesisChunk.redundancyScore = 1
      }
      continue
    }

    let bestMatch: RagChunk | null = null
    let bestSimilarity = 0

    for (const publicationChunk of publicationChunks) {
      const lexical = lexicalOverlapScore(thesisChunk.text, publicationChunk.text)
      if (lexical < lexicalThreshold) continue

      const cosine = thesisChunk.embedding && publicationChunk.embedding
        ? cosineSimilarity(thesisChunk.embedding, publicationChunk.embedding)
        : 0

      if (cosine < cosineThreshold) continue

      const combined = (cosine + lexical) / 2
      if (!bestMatch || combined > bestSimilarity) {
        bestMatch = publicationChunk
        bestSimilarity = combined
      }
    }

    if (!bestMatch) continue

    const novelRatio = novelSentenceRatio(thesisChunk.text, bestMatch.text)
    if (novelRatio >= novelSentenceThreshold) continue

    thesisChunk.isRedundant = true
    thesisChunk.redundantOf = bestMatch.id
    thesisChunk.redundancyScore = bestSimilarity
  }
}

function normalizeDocument(raw: unknown): RagDocument | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>

  const id = normalizeTextField(value.id)
  const ragId = normalizeTextField(value.ragId)
  const fileName = normalizeTextField(value.fileName)
  const fileType = value.fileType === 'pdf' || value.fileType === 'docx' || value.fileType === 'txt'
    ? value.fileType
    : 'txt'
  const status = value.status === 'active' || value.status === 'failed' || value.status === 'deleted'
    ? value.status
    : 'failed'
  const uploadedAt = normalizeTextField(value.uploadedAt) || new Date(0).toISOString()
  const sourceType = value.sourceType === 'crawl' ? 'crawl' : 'upload'
  const sourceRef = normalizeTextField(value.sourceRef)
  const documentCount = parseInteger(value.documentCount) || 0

  if (!id || !ragId || !fileName) return null

  const inferredRole = inferSourceRole(fileName, sourceType)

  return {
    id,
    ragId,
    fileName,
    fileType,
    status,
    uploadedAt,
    sourceType,
    sourceRef,
    documentCount,
    sourceRole: normalizeSourceRole(value.sourceRole, inferredRole),
    metadata: normalizeMetadata(value.metadata),
  }
}

function normalizeChunk(raw: unknown, documentsById: Map<string, RagDocument>): RagChunk | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>

  const id = normalizeTextField(value.id)
  const ragId = normalizeTextField(value.ragId)
  const documentId = normalizeTextField(value.documentId)
  const text = normalizeTextField(value.text)
  const sourceName = normalizeTextField(value.sourceName)

  if (!id || !ragId || !documentId || !text || !sourceName) return null

  const sourceDoc = documentsById.get(documentId)
  const sourceRole = normalizeSourceRole(value.sourceRole, sourceDoc?.sourceRole || 'other')
  const chunkIndex = parseInteger(value.chunkIndex) || 0
  const paperKey = normalizeTextField(value.paperKey)
    || resolvePaperKey(sourceName, sourceDoc?.metadata)
  const documentTitle = normalizeTextField(value.documentTitle) || sourceDoc?.metadata?.title
  const pageStart = parseInteger(value.pageStart)
  const pageEnd = parseInteger(value.pageEnd)
  const redundantOf = normalizeTextField(value.redundantOf)
  const redundancyScore = parseNumber(value.redundancyScore)
  const isRedundant = typeof value.isRedundant === 'boolean' ? value.isRedundant : false
  const headingPath = normalizeTextField(value.headingPath)
  const textHash = normalizeTextField(value.textHash) || getTextHash(text)
  const embedding = Array.isArray(value.embedding)
    ? value.embedding
        .map(item => parseNumber(item))
        .filter((item): item is number => typeof item === 'number')
    : undefined

  return {
    id,
    ragId,
    documentId,
    text,
    textHash,
    embedding: embedding?.length ? embedding : undefined,
    sourceName,
    chunkIndex,
    sourceRole,
    paperKey,
    documentTitle,
    pageStart,
    pageEnd,
    redundantOf,
    redundancyScore,
    isRedundant,
    headingPath,
  }
}

async function readStore(): Promise<RagStore> {
  const rawStore = await readJsonFile<Partial<RagStore>>(RAG_STORE_PATH, {
    documents: [],
    chunks: [],
  })

  const documents = Array.isArray(rawStore.documents)
    ? rawStore.documents
        .map(item => normalizeDocument(item))
        .filter((item): item is RagDocument => Boolean(item))
    : []

  const docById = new Map(documents.map(doc => [doc.id, doc]))
  const chunks = Array.isArray(rawStore.chunks)
    ? rawStore.chunks
        .map(item => normalizeChunk(item, docById))
        .filter((item): item is RagChunk => Boolean(item))
    : []

  return { documents, chunks }
}

async function writeStore(store: RagStore): Promise<void> {
  await writeJsonFileAtomic(RAG_STORE_PATH, store)
}

function getChunkingConfig(sourceRole: RagSourceRole) {
  const defaultChunkSize = sourceRole === 'thesis' ? 1200 : sourceRole === 'publication' ? 900 : 900
  const defaultOverlap = sourceRole === 'thesis' ? 180 : sourceRole === 'publication' ? 140 : 150
  const sizeEnv = sourceRole === 'thesis'
    ? process.env.RAG_CHUNK_SIZE_THESIS || process.env.RAG_CHUNK_SIZE
    : sourceRole === 'publication'
      ? process.env.RAG_CHUNK_SIZE_PUBLICATION || process.env.RAG_CHUNK_SIZE
      : process.env.RAG_CHUNK_SIZE
  const overlapEnv = sourceRole === 'thesis'
    ? process.env.RAG_CHUNK_OVERLAP_THESIS || process.env.RAG_CHUNK_OVERLAP
    : sourceRole === 'publication'
      ? process.env.RAG_CHUNK_OVERLAP_PUBLICATION || process.env.RAG_CHUNK_OVERLAP
      : process.env.RAG_CHUNK_OVERLAP

  const chunkSize = Number.parseInt(sizeEnv || String(defaultChunkSize), 10)
  const overlap = Number.parseInt(overlapEnv || String(defaultOverlap), 10)

  return {
    chunkSize: Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : defaultChunkSize,
    overlap: Number.isFinite(overlap) && overlap >= 0 ? overlap : defaultOverlap,
  }
}

export async function listRagDocuments(ragId: string): Promise<RagDocument[]> {
  const store = await readStore()
  return store.documents.filter(doc => doc.ragId === ragId && doc.status !== 'deleted')
}

export async function ingestRagDocument(params: {
  ragId: string
  fileName: string
  fileType: 'pdf' | 'docx' | 'txt'
  text: string
  sourceType: 'upload' | 'crawl'
  sourceRef?: string
  sourceRole?: RagSourceRole
  metadata?: RagDocumentMetadata
}): Promise<RagDocument> {
  const {
    ragId,
    fileName,
    fileType,
    text,
    sourceType,
    sourceRef,
    sourceRole,
    metadata,
  } = params

  const store = await readStore()
  const inferredSourceRole = inferSourceRole(fileName, sourceType)
  const finalSourceRole = normalizeSourceRole(sourceRole, inferredSourceRole)
  const finalMetadata = normalizeMetadata(metadata)
  const paperKey = resolvePaperKey(fileName, finalMetadata)
  const { chunkSize, overlap } = getChunkingConfig(finalSourceRole)

  const chunks = chunkText(text, chunkSize, overlap)
  const documentId = crypto.randomUUID()

  const ragChunks: RagChunk[] = []
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]
    const embedding = await ollamaEmbedding(chunk)
    ragChunks.push({
      id: crypto.randomUUID(),
      ragId,
      documentId,
      text: chunk,
      textHash: getTextHash(chunk),
      embedding: embedding || undefined,
      sourceName: fileName,
      chunkIndex,
      sourceRole: finalSourceRole,
      paperKey,
      documentTitle: finalMetadata?.title,
      isRedundant: false,
    })
  }

  const document: RagDocument = {
    id: documentId,
    ragId,
    fileName,
    fileType,
    status: chunks.length ? 'active' : 'failed',
    uploadedAt: new Date().toISOString(),
    sourceType,
    sourceRef,
    documentCount: chunks.length,
    sourceRole: finalSourceRole,
    metadata: finalMetadata,
  }

  const replacedDocIds = new Set(
    store.documents
      .filter(doc => doc.ragId === ragId && doc.fileName === fileName)
      .map(doc => doc.id)
  )

  store.documents = store.documents.filter(doc => !(doc.ragId === ragId && doc.fileName === fileName))
  store.documents.push(document)
  store.chunks = store.chunks.filter(chunk => !replacedDocIds.has(chunk.documentId))
  store.chunks.push(...ragChunks)
  annotateThesisRedundancy(store, ragId)

  await writeStore(store)

  return document
}

export async function deleteRagDocuments(ragId: string, documentNames: string[]): Promise<number> {
  const store = await readStore()
  const names = new Set(documentNames)

  const docIdsToDelete = store.documents
    .filter(doc => doc.ragId === ragId && names.has(doc.fileName))
    .map(doc => doc.id)

  const docIdSet = new Set(docIdsToDelete)

  store.documents = store.documents.map(doc => {
    if (docIdSet.has(doc.id)) {
      return { ...doc, status: 'deleted' as const }
    }
    return doc
  })

  store.chunks = store.chunks.filter(chunk => !docIdSet.has(chunk.documentId))

  await writeStore(store)
  return docIdsToDelete.length
}

export async function retrieveRelevantChunks(params: {
  ragId: string
  query: string
  topK?: number
  includeSourceRoles?: RagSourceRole[]
  includeDocumentNames?: string[]
  excludeRedundant?: boolean
  maxChunksPerDocument?: number
}): Promise<RagChunk[]> {
  const { ragId, query } = params
  const topK = params.topK ?? DEFAULT_RAG_TOP_K
  const includeSourceRoles = Array.isArray(params.includeSourceRoles)
    ? params.includeSourceRoles
    : []
  const includeDocumentNames = Array.isArray(params.includeDocumentNames)
    ? params.includeDocumentNames
    : []
  const excludeRedundant = params.excludeRedundant ?? false
  const maxChunksPerDocument = typeof params.maxChunksPerDocument === 'number' && params.maxChunksPerDocument > 0
    ? Math.floor(params.maxChunksPerDocument)
    : undefined

  const store = await readStore()
  const roleFilter = includeSourceRoles.length ? new Set(includeSourceRoles) : null
  const nameFilter = includeDocumentNames.length ? new Set(includeDocumentNames) : null
  let candidates = store.chunks.filter(chunk => chunk.ragId === ragId)
  if (roleFilter) {
    candidates = candidates.filter(chunk => roleFilter.has(chunk.sourceRole))
  }
  if (nameFilter) {
    candidates = candidates.filter(chunk => nameFilter.has(chunk.sourceName))
  }
  if (excludeRedundant) {
    candidates = candidates.filter(chunk => !chunk.isRedundant)
  }

  if (!candidates.length) return []

  const queryEmbedding = await ollamaEmbedding(query)

  const ranked = candidates
    .map(chunk => {
      let score = queryEmbedding && chunk.embedding
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : keywordScore(query, chunk.text)

      if (chunk.sourceRole === 'thesis' && chunk.isRedundant && chunk.redundantOf) {
        score -= getRedundantThesisPenalty()
      }

      return { chunk, score }
    })
    .sort((a, b) => b.score - a.score)

  const boundedTopK = Math.max(1, topK)
  if (!maxChunksPerDocument) {
    return ranked.slice(0, boundedTopK).map(item => item.chunk)
  }

  const selected: RagChunk[] = []
  const perDocumentCount = new Map<string, number>()

  for (const item of ranked) {
    if (selected.length >= boundedTopK) break
    const count = perDocumentCount.get(item.chunk.documentId) || 0
    if (count >= maxChunksPerDocument) continue
    selected.push(item.chunk)
    perDocumentCount.set(item.chunk.documentId, count + 1)
  }

  return selected
}
