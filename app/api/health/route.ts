import { NextRequest, NextResponse } from 'next/server'
import { enforceApiSecurity } from '@/lib/server/security'
import { getDataRoot } from '@/lib/server/fsStore'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const securityError = enforceApiSecurity(request, {
    routeId: 'health',
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_HEALTH_MAX || '120', 10),
    skipAuth: process.env.HEALTH_SKIP_AUTH === 'true',
  })
  if (securityError) return securityError

  const chatProvider = (process.env.CHAT_PROVIDER || 'ollama').toLowerCase()
  let chatStatus: 'ok' | 'down' | 'misconfigured' = 'down'
  let ollamaStatus: 'ok' | 'down' | 'skipped' = 'skipped'
  let nvidiaStatus: 'ok' | 'down' | 'skipped' | 'misconfigured' = 'skipped'

  if (chatProvider === 'nvidia') {
    const nvidiaBase = (process.env.NVIDIA_API_BASE_URL || process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '')
    const nvidiaModelsUrl = nvidiaBase.endsWith('/models') ? nvidiaBase : `${nvidiaBase}/models`
    const nvidiaApiKey = process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY

    if (!nvidiaApiKey) {
      nvidiaStatus = 'misconfigured'
      chatStatus = 'misconfigured'
    } else {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3000)
        const res = await fetch(nvidiaModelsUrl, {
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${nvidiaApiKey}`,
          },
        }).finally(() => clearTimeout(timeout))
        if (res.ok) {
          nvidiaStatus = 'ok'
          chatStatus = 'ok'
        } else {
          nvidiaStatus = 'down'
          chatStatus = 'down'
        }
      } catch {
        nvidiaStatus = 'down'
        chatStatus = 'down'
      }
    }
  } else {
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${ollamaBaseUrl}/api/tags`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))
      if (res.ok) {
        ollamaStatus = 'ok'
        chatStatus = 'ok'
      } else {
        ollamaStatus = 'down'
        chatStatus = 'down'
      }
    } catch {
      ollamaStatus = 'down'
      chatStatus = 'down'
    }
  }

  return NextResponse.json({
    status: 'ok',
    services: {
      chat_provider: chatProvider,
      chat_backend: chatStatus,
      ollama: ollamaStatus,
      nvidia: nvidiaStatus,
    },
    data_root: getDataRoot(),
    timestamp: new Date().toISOString(),
  })
}
