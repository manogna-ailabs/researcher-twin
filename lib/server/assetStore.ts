import { promises as fs } from 'fs'
import { ensureDataDirs, readJsonFile, resolveDataPath, writeJsonFileAtomic } from '@/lib/server/fsStore'
import { looksLikeText, sanitizeFileName } from '@/lib/server/text'

export type AssetRecord = {
  asset_id: string
  file_name: string
  mime_type: string
  file_path: string
  uploaded_at: string
  text_content: string
}

type AssetManifest = {
  assets: AssetRecord[]
}

const ASSET_MANIFEST_PATH = resolveDataPath('assets', 'manifest.json')

async function readManifest(): Promise<AssetManifest> {
  return readJsonFile<AssetManifest>(ASSET_MANIFEST_PATH, { assets: [] })
}

async function writeManifest(manifest: AssetManifest): Promise<void> {
  await writeJsonFileAtomic(ASSET_MANIFEST_PATH, manifest)
}

function inferFileType(fileName: string): 'pdf' | 'docx' | 'txt' {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  return 'txt'
}

function normalizeExtractedText(input: string): string {
  return input
    .replace(/\u0000/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function extractPdfText(buffer: Buffer, fileName: string): Promise<string> {
  try {
    const pdfParseModule = await import('pdf-parse')
    const pdfParseFn = (pdfParseModule.default || pdfParseModule) as (dataBuffer: Buffer) => Promise<{ text?: string }>
    const parsed = await pdfParseFn(buffer)
    return normalizeExtractedText(parsed?.text || '')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown PDF parsing error'
    throw new Error(`PDF extraction failed for ${fileName}: ${message}`)
  }
}

export async function extractTextFromFile(file: File): Promise<{ text: string; fileType: 'pdf' | 'docx' | 'txt'; warning?: string }> {
  const fileName = file.name || 'uploaded_file'
  const fileType = inferFileType(fileName)

  const buffer = Buffer.from(await file.arrayBuffer())

  if (fileType === 'pdf' || file.type === 'application/pdf') {
    try {
      const text = await extractPdfText(buffer, fileName)
      if (!text) {
        return {
          text: '',
          fileType: 'pdf',
          warning: `Parsed ${fileName} but no extractable text was found (possible scanned/image-only PDF).`,
        }
      }

      return {
        text,
        fileType: 'pdf',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to parse ${fileName}`
      return {
        text: '',
        fileType: 'pdf',
        warning: message,
      }
    }
  }

  if (file.type === 'text/plain' || fileType === 'txt' || looksLikeText(buffer)) {
    return {
      text: normalizeExtractedText(buffer.toString('utf8')),
      fileType,
    }
  }

  return {
    text: '',
    fileType,
    warning: `Could not reliably extract text from ${fileName}. Convert it to TXT for best results.`,
  }
}

export async function saveUploadedFiles(files: File[]): Promise<{
  uploaded: AssetRecord[]
  failed: { file_name: string; error: string }[]
}> {
  await ensureDataDirs()

  const manifest = await readManifest()
  const uploaded: AssetRecord[] = []
  const failed: { file_name: string; error: string }[] = []

  for (const file of files) {
    try {
      const assetId = crypto.randomUUID()
      const safeName = sanitizeFileName(file.name || 'file')
      const storedName = `${assetId}_${safeName}`
      const absolutePath = resolveDataPath('assets', storedName)

      const buffer = Buffer.from(await file.arrayBuffer())
      await fs.writeFile(absolutePath, buffer)

      const { text } = await extractTextFromFile(file)
      const record: AssetRecord = {
        asset_id: assetId,
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_path: absolutePath,
        uploaded_at: new Date().toISOString(),
        text_content: text,
      }

      manifest.assets.push(record)
      uploaded.push(record)
    } catch (error) {
      failed.push({
        file_name: file.name,
        error: error instanceof Error ? error.message : 'Unknown upload error',
      })
    }
  }

  await writeManifest(manifest)

  return { uploaded, failed }
}

export async function getAssetsByIds(assetIds: string[]): Promise<AssetRecord[]> {
  if (!assetIds.length) return []
  const manifest = await readManifest()
  const wanted = new Set(assetIds)
  return manifest.assets.filter(asset => wanted.has(asset.asset_id))
}

export async function getAssetByFileName(fileName: string): Promise<AssetRecord | null> {
  const manifest = await readManifest()
  return manifest.assets.find(asset => asset.file_name === fileName) || null
}
