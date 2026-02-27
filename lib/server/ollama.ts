export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatCompletionOptions = {
  model?: string
  temperature?: number
  top_p?: number
}

type ChatProvider = 'ollama' | 'nvidia'

type OllamaChatResponse = {
  message?: {
    content?: string
  }
}

type OllamaEmbeddingResponse = {
  embedding?: number[]
}

type NvidiaChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
}

function getOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
}

function getNvidiaBaseUrl(): string {
  const raw =
    process.env.NVIDIA_API_BASE_URL
    || process.env.NVIDIA_NIM_BASE_URL
    || 'https://integrate.api.nvidia.com/v1'
  return raw.replace(/\/+$/, '')
}

function getChatProvider(): ChatProvider {
  const provider = (process.env.CHAT_PROVIDER || 'ollama').toLowerCase()
  if (provider === 'nvidia') return 'nvidia'
  return 'ollama'
}

function getNvidiaApiKey(): string {
  const key = process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY
  if (!key) {
    throw new Error('NVIDIA API key missing. Set NVIDIA_API_KEY (or NGC_API_KEY).')
  }
  return key
}

function getNvidiaChatUrl(): string {
  const configured = process.env.NVIDIA_CHAT_URL?.trim()
  if (configured) return configured
  const base = getNvidiaBaseUrl()
  if (base.endsWith('/chat/completions')) return base
  return `${base}/chat/completions`
}

export function getChatModel(): string {
  if (getChatProvider() === 'nvidia') {
    return process.env.NVIDIA_CHAT_MODEL || 'nvidia/nemotron-nano-12b-v2-vl'
  }
  return process.env.OLLAMA_CHAT_MODEL || 'llama3.1:8b'
}

export function getEmbeddingModel(): string {
  return process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text'
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function normalizeNvidiaContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()

  if (Array.isArray(content)) {
    const text = content
      .map(part => (part && typeof part === 'object' ? (part as { text?: string }).text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }

  return ''
}

export async function ollamaChat(messages: ChatMessage[], options: ChatCompletionOptions = {}): Promise<string> {
  const model = options.model || getChatModel()
  const temperature = parseOptionalNumber(options.temperature)
  const topP = parseOptionalNumber(options.top_p)

  if (getChatProvider() === 'nvidia') {
    const response = await fetch(getNvidiaChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getNvidiaApiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? Number.parseFloat(process.env.NVIDIA_TEMPERATURE || process.env.OLLAMA_TEMPERATURE || '0.4'),
        top_p: topP ?? Number.parseFloat(process.env.NVIDIA_TOP_P || '0.95'),
        stream: false,
      }),
    })

    if (!response.ok) {
      const details = await response.text()
      throw new Error(`NVIDIA chat failed (${response.status}): ${details}`)
    }

    const data = (await response.json()) as NvidiaChatResponse
    const content = normalizeNvidiaContent(data.choices?.[0]?.message?.content)
    if (!content) {
      throw new Error('NVIDIA chat returned empty content')
    }
    return content
  }

  const response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages,
      options: {
        temperature: temperature ?? Number.parseFloat(process.env.OLLAMA_TEMPERATURE || '0.4'),
        ...(typeof topP === 'number' ? { top_p: topP } : {}),
      },
    }),
  })

  if (!response.ok) {
    const details = await response.text()
    throw new Error(`Ollama chat failed (${response.status}): ${details}`)
  }

  const data = (await response.json()) as OllamaChatResponse
  const content = data.message?.content?.trim()
  if (!content) {
    throw new Error('Ollama chat returned empty content')
  }

  return content
}

export async function ollamaEmbedding(text: string): Promise<number[] | null> {
  const trimmed = text.trim()
  if (!trimmed) return null

  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getEmbeddingModel(),
        prompt: trimmed,
      }),
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as OllamaEmbeddingResponse
    if (!Array.isArray(data.embedding)) {
      return null
    }

    return data.embedding
  } catch {
    return null
  }
}
