import { promises as fs } from 'fs'
import path from 'path'

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data')

const FILE_WRITE_RETRIES = 3

export function getDataRoot(): string {
  return DATA_ROOT
}

export function resolveDataPath(...parts: string[]): string {
  return path.join(DATA_ROOT, ...parts)
}

export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      // Read-only runtimes (for example serverless) can still read pre-bundled dirs.
      const existing = await fs.stat(dirPath).catch(() => null)
      if (existing?.isDirectory()) return
    }
    throw error
  }
}

export async function ensureDataDirs(): Promise<void> {
  await Promise.all([
    ensureDir(resolveDataPath('rag')),
    ensureDir(resolveDataPath('assets')),
    ensureDir(resolveDataPath('scheduler')),
  ])
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      const reason = error instanceof Error ? error.message : 'unknown error'
      console.warn(`[fsStore] Falling back for unreadable JSON file: ${filePath} (${reason})`)
    }
    return fallback
  }
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath))

  const payload = JSON.stringify(data, null, 2)
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`

  for (let attempt = 0; attempt < FILE_WRITE_RETRIES; attempt++) {
    try {
      await fs.writeFile(tempFile, payload, 'utf8')
      await fs.rename(tempFile, filePath)
      return
    } catch (error) {
      if (attempt === FILE_WRITE_RETRIES - 1) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}
