import { NextRequest, NextResponse } from 'next/server'
/**
 * RAG API route.
 * Responsibilities:
 * - List indexed documents.
 * - Ingest uploaded files and crawled content.
 * - Delete indexed documents and rebuild corpus subsets.
 */
import { DEFAULT_RAG_ID } from '@/lib/config/env'
import { ensureDataDirs } from '@/lib/server/fsStore'
import { enforceApiSecurity } from '@/lib/server/security'
import { withCanonicalMetadata } from '@/lib/config/publications'
import {
  deleteRagDocuments,
  ingestRagDocument,
  listRagDocuments,
  type RagDocumentMetadata,
  type RagSourceRole,
} from '@/lib/server/ragStore'
import { extractTextFromFile } from '@/lib/server/assetStore'
import { stripHtmlToText } from '@/lib/server/text'

export const runtime = 'nodejs'

function securityGuard(request: NextRequest): NextResponse | null {
  return enforceApiSecurity(request, {
    routeId: 'rag',
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_RAG_MAX || '90', 10),
  })
}

function getFileTypeFromName(fileName: string): 'pdf' | 'docx' | 'txt' {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  return 'txt'
}

function inferSourceRoleFromName(fileName: string, sourceType: 'upload' | 'crawl'): RagSourceRole {
  if (sourceType === 'crawl') return 'web'
  if (/thesis|dissertation/i.test(fileName)) return 'thesis'
  return 'publication'
}

function parseSourceRole(input: unknown, fallback: RagSourceRole): RagSourceRole {
  if (input === 'publication' || input === 'thesis' || input === 'web' || input === 'other') {
    return input
  }
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase()
    if (normalized === 'publication' || normalized === 'thesis' || normalized === 'web' || normalized === 'other') {
      return normalized
    }
  }
  return fallback
}

function parseTextField(input: FormDataEntryValue | null): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  return trimmed.length ? trimmed : undefined
}

function parseTopics(input: FormDataEntryValue | null): string[] | undefined {
  if (typeof input !== 'string') return undefined
  const raw = input.trim()
  if (!raw) return undefined

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const topics = parsed
          .map(item => String(item || '').trim())
          .filter(Boolean)
        return topics.length ? topics : undefined
      }
    } catch {
      // Fall through to delimiter-based parsing below.
    }
  }

  const topics = raw
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean)

  return topics.length ? topics : undefined
}

function buildUploadMetadata(formData: FormData): RagDocumentMetadata | undefined {
  const metadata: RagDocumentMetadata = {
    title: parseTextField(formData.get('title')),
    year: parseTextField(formData.get('year')),
    venue: parseTextField(formData.get('venue')),
    chapter: parseTextField(formData.get('chapter')),
    section: parseTextField(formData.get('section')),
    subsection: parseTextField(formData.get('subsection')),
    topics: parseTopics(formData.get('topics')),
    canonicalCitation: parseTextField(formData.get('canonicalCitation')),
  }

  if (
    !metadata.title
    && !metadata.year
    && !metadata.venue
    && !metadata.chapter
    && !metadata.section
    && !metadata.subsection
    && !metadata.topics?.length
    && !metadata.canonicalCitation
  ) {
    return undefined
  }

  return metadata
}

function normalizeExtractedText(input: string): string {
  return input
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function hashSuffix(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36).slice(0, 7)
}

function urlToFileName(url: URL, ext: 'txt' | 'pdf'): string {
  const stem = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`
    .replace(/[^a-zA-Z0-9/_-]/g, '_')
    .replace(/\//g, '_')
    .replace(/^_+|_+$/g, '') || 'crawled_page'

  const withExt = /\.[a-z0-9]{2,5}$/i.test(stem) ? stem : `${stem}.${ext}`
  if (!url.search) return withExt

  return withExt.replace(/(\.[a-z0-9]{2,5})$/i, `_${hashSuffix(url.search)}$1`)
}

function isLikelyPdfUrl(url: URL): boolean {
  const full = `${url.pathname}${url.search}`.toLowerCase()
  return (
    full.includes('.pdf') ||
    url.pathname.toLowerCase().includes('/pdf/') ||
    /[?&](download|format)=pdf/i.test(url.search)
  )
}

function extractHttpLinks(html: string, baseUrl: URL): URL[] {
  const urls: URL[] = []
  const seen = new Set<string>()
  const hrefRegex = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi

  let match: RegExpExecArray | null
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = String(match[1] || match[2] || match[3] || '')
      .trim()
      .replace(/&amp;/g, '&')

    if (!raw || raw.startsWith('#')) continue
    if (/^(mailto:|javascript:|tel:)/i.test(raw)) continue

    try {
      const url = new URL(raw, baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) continue
      const key = url.toString()
      if (seen.has(key)) continue
      seen.add(key)
      urls.push(url)
    } catch {
      continue
    }
  }

  return urls
}

async function fetchUrlWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'ResearchTwinCrawler/1.0',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function extractPdfTextFromUrl(url: URL): Promise<string> {
  const response = await fetchUrlWithTimeout(url.toString(), 45_000)
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF (${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('pdf') && !isLikelyPdfUrl(url)) {
    throw new Error(`URL does not appear to be a PDF (content-type: ${contentType || 'unknown'})`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const pdfParseModule = await import('pdf-parse')
  const pdfParseFn = (pdfParseModule.default || pdfParseModule) as (dataBuffer: Buffer) => Promise<{ text?: string }>
  const parsed = await pdfParseFn(buffer)
  const text = normalizeExtractedText(parsed?.text || '')
  if (!text) {
    throw new Error('PDF had no extractable text (possible scanned/image-only paper)')
  }
  return text
}

// POST - List documents (JSON body) or Upload + index (formData)
export async function POST(request: NextRequest) {
  const securityError = securityGuard(request)
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const contentType = request.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      const body = await request.json()
      const ragId = String(body.ragId || DEFAULT_RAG_ID)

      const documents = await listRagDocuments(ragId)
      return NextResponse.json({
        success: true,
        documents: documents.map(doc => ({
          fileName: doc.fileName,
          fileType: doc.fileType,
          status: doc.status,
          uploadedAt: doc.uploadedAt,
          documentCount: doc.documentCount,
          sourceRole: doc.sourceRole,
          metadata: doc.metadata,
        })),
        ragId,
        timestamp: new Date().toISOString(),
      })
    }

    const formData = await request.formData()
    const ragId = String(formData.get('ragId') || DEFAULT_RAG_ID)
    const file = formData.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          success: false,
          error: 'ragId and file are required',
        },
        { status: 400 }
      )
    }

    const { text, fileType, warning } = await extractTextFromFile(file)

    if (!text || text.trim().length < 30) {
      return NextResponse.json(
        {
          success: false,
          error: warning || `Could not extract usable text from ${file.name}. For PDFs, ensure they contain selectable text (not only scanned images).`,
        },
        { status: 400 }
      )
    }

    const sourceRole = parseSourceRole(
      formData.get('sourceRole'),
      inferSourceRoleFromName(file.name, 'upload')
    )
    const metadata = withCanonicalMetadata(file.name, buildUploadMetadata(formData))

    const document = await ingestRagDocument({
      ragId,
      fileName: file.name,
      fileType: fileType || getFileTypeFromName(file.name),
      text,
      sourceType: 'upload',
      sourceRef: file.name,
      sourceRole,
      metadata,
    })

    return NextResponse.json({
      success: true,
      message: warning
        ? `${warning} Indexed text content that could be extracted.`
        : 'Document uploaded and indexed successfully',
      fileName: document.fileName,
      fileType: document.fileType,
      documentCount: document.documentCount,
      sourceRole: document.sourceRole,
      metadata: document.metadata,
      ragId,
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

// PATCH - Crawl website and index page text
export async function PATCH(request: NextRequest) {
  const securityError = securityGuard(request)
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const body = await request.json()
    const ragId = String(body.ragId || DEFAULT_RAG_ID)
    const url = String(body.url || '')
    const rebuild = Boolean(body.rebuild || body.reset || body.fresh)
    const discoverLinks = Boolean(body.discoverLinks || body.crawlPapers || body.mode === 'publications')
    const maxPdfLinks = Math.max(1, Math.min(200, Number.parseInt(String(body.maxPdfLinks || '50'), 10) || 50))
    const maxPages = Math.max(0, Math.min(100, Number.parseInt(String(body.maxPages || '15'), 10) || 15))

    if (!url) {
      return NextResponse.json(
        {
          success: false,
          error: 'ragId and url are required',
        },
        { status: 400 }
      )
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid URL',
        },
        { status: 400 }
      )
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Only http/https URLs are supported',
        },
        { status: 400 }
      )
    }

    const response = await fetchUrlWithTimeout(parsedUrl.toString(), 30_000)

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to crawl website: ${response.status}`,
        },
        { status: response.status }
      )
    }

    const html = await response.text()
    const text = stripHtmlToText(html)

    if (text.length < 100) {
      return NextResponse.json(
        {
          success: false,
          error: 'Crawled page did not contain enough extractable text',
        },
        { status: 400 }
      )
    }

    let deletedCount = 0
    if (rebuild) {
      const existing = await listRagDocuments(ragId)
      if (existing.length > 0) {
        deletedCount = await deleteRagDocuments(ragId, existing.map(doc => doc.fileName))
      }
    }

    await ingestRagDocument({
      ragId,
      fileName: urlToFileName(parsedUrl, 'txt'),
      fileType: 'txt',
      text,
      sourceType: 'crawl',
      sourceRef: parsedUrl.toString(),
      sourceRole: 'web',
    })

    let indexedPages = 1
    let indexedPdfs = 0
    const failures: Array<{ url: string; error: string }> = []

    if (discoverLinks) {
      const links = extractHttpLinks(html, parsedUrl)
      const pdfLinks = links.filter(isLikelyPdfUrl).slice(0, maxPdfLinks)

      for (const pdfLink of pdfLinks) {
        try {
          const pdfText = await extractPdfTextFromUrl(pdfLink)
          if (pdfText.length < 100) {
            failures.push({
              url: pdfLink.toString(),
              error: 'Extracted text too short',
            })
            continue
          }

          await ingestRagDocument({
            ragId,
            fileName: urlToFileName(pdfLink, 'pdf'),
            fileType: 'pdf',
            text: pdfText,
            sourceType: 'crawl',
            sourceRef: pdfLink.toString(),
            sourceRole: 'web',
          })
          indexedPdfs += 1
        } catch (error) {
          failures.push({
            url: pdfLink.toString(),
            error: error instanceof Error ? error.message : 'PDF ingestion failed',
          })
        }
      }

      if (maxPages > 0) {
        const seedPath = parsedUrl.pathname.replace(/\/+$/, '')
        const sameSitePages = links
          .filter(link => !isLikelyPdfUrl(link))
          .filter(link => link.hostname === parsedUrl.hostname)
          .filter(link => link.toString() !== parsedUrl.toString())
          .filter(link => {
            if (!seedPath) return true
            const path = link.pathname.replace(/\/+$/, '')
            return path === seedPath || path.startsWith(`${seedPath}/`)
          })
          .slice(0, maxPages)

        for (const pageLink of sameSitePages) {
          try {
            const pageResponse = await fetchUrlWithTimeout(pageLink.toString(), 20_000)
            if (!pageResponse.ok) {
              failures.push({
                url: pageLink.toString(),
                error: `Failed to crawl page (${pageResponse.status})`,
              })
              continue
            }

            const pageHtml = await pageResponse.text()
            const pageText = stripHtmlToText(pageHtml)
            if (pageText.length < 100) {
              continue
            }

            await ingestRagDocument({
              ragId,
              fileName: urlToFileName(pageLink, 'txt'),
              fileType: 'txt',
              text: pageText,
              sourceType: 'crawl',
              sourceRef: pageLink.toString(),
              sourceRole: 'web',
            })
            indexedPages += 1
          } catch (error) {
            failures.push({
              url: pageLink.toString(),
              error: error instanceof Error ? error.message : 'Page crawl failed',
            })
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: discoverLinks
        ? `Website crawl completed. Indexed ${indexedPages} page(s) and ${indexedPdfs} PDF paper(s).`
        : 'Website crawl completed and indexed successfully.',
      url: parsedUrl.toString(),
      ragId,
      rebuild,
      deletedCount,
      indexedPages,
      indexedPdfs,
      failures: failures.slice(0, 20),
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

// DELETE - Remove documents from local knowledge base
export async function DELETE(request: NextRequest) {
  const securityError = securityGuard(request)
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const body = await request.json()
    const ragId = String(body.ragId || DEFAULT_RAG_ID)
    const documentNames = body.documentNames

    if (!Array.isArray(documentNames)) {
      return NextResponse.json(
        {
          success: false,
          error: 'ragId and documentNames array are required',
        },
        { status: 400 }
      )
    }

    const deletedCount = await deleteRagDocuments(ragId, documentNames.map(String))

    return NextResponse.json({
      success: true,
      message: 'Documents deleted successfully',
      deletedCount,
      ragId,
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
