import { NextRequest, NextResponse } from 'next/server'

type RateLimitEntry = {
  count: number
  resetAt: number
}

type SecurityOptions = {
  routeId: string
  maxRequests?: number
  windowMs?: number
  skipAuth?: boolean
}

const globalForRateLimit = globalThis as typeof globalThis & {
  __researchTwinRateLimit?: Map<string, RateLimitEntry>
}

const rateLimitStore = globalForRateLimit.__researchTwinRateLimit ?? new Map<string, RateLimitEntry>()
if (!globalForRateLimit.__researchTwinRateLimit) {
  globalForRateLimit.__researchTwinRateLimit = rateLimitStore
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown'
  }
  const requestWithIp = request as NextRequest & { ip?: string }
  return request.headers.get('x-real-ip') || requestWithIp.ip || 'unknown'
}

function getAuthHeaderToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization')
  if (!authHeader) return null

  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim()
  }

  if (authHeader.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8')
    const [user, pass] = decoded.split(':')
    const basicUser = process.env.API_BASIC_USER
    const basicPass = process.env.API_BASIC_PASS
    if (basicUser && basicPass && user === basicUser && pass === basicPass) {
      return '__basic_ok__'
    }
  }

  return null
}

function isAuthValid(request: NextRequest): boolean {
  const requiredBearer = process.env.API_AUTH_TOKEN
  const basicUser = process.env.API_BASIC_USER
  const basicPass = process.env.API_BASIC_PASS

  if (!requiredBearer && !(basicUser && basicPass)) {
    return true
  }

  const headerToken = getAuthHeaderToken(request)
  const customToken = request.headers.get('x-api-token')

  if (requiredBearer && (headerToken === requiredBearer || customToken === requiredBearer)) {
    return true
  }

  if (headerToken === '__basic_ok__') {
    return true
  }

  return false
}

function getRateLimitConfig(options?: Pick<SecurityOptions, 'maxRequests' | 'windowMs'>) {
  const maxRequests = options?.maxRequests
    ?? Number.parseInt(process.env.RATE_LIMIT_MAX || '120', 10)
  const windowMs = options?.windowMs
    ?? Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)

  return {
    maxRequests: Number.isFinite(maxRequests) ? maxRequests : 120,
    windowMs: Number.isFinite(windowMs) ? windowMs : 60_000,
  }
}

function checkRateLimit(key: string, maxRequests: number, windowMs: number): {
  allowed: boolean
  remaining: number
  retryAfterSec: number
} {
  const now = Date.now()
  const current = rateLimitStore.get(key)

  if (!current || now > current.resetAt) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + windowMs,
    })
    return {
      allowed: true,
      remaining: Math.max(0, maxRequests - 1),
      retryAfterSec: Math.ceil(windowMs / 1000),
    }
  }

  current.count += 1
  rateLimitStore.set(key, current)

  const remaining = Math.max(0, maxRequests - current.count)
  const retryAfterSec = Math.ceil((current.resetAt - now) / 1000)

  return {
    allowed: current.count <= maxRequests,
    remaining,
    retryAfterSec,
  }
}

export function enforceApiSecurity(
  request: NextRequest,
  options: SecurityOptions
): NextResponse | null {
  if (!options.skipAuth && !isAuthValid(request)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Bearer realm="research-twin-api"',
        },
      }
    )
  }

  const { maxRequests, windowMs } = getRateLimitConfig(options)
  const routeId = options.routeId
  const ip = getClientIp(request)
  const rateLimitKey = `${routeId}:${ip}`

  const result = checkRateLimit(rateLimitKey, maxRequests, windowMs)
  if (!result.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: 'Rate limit exceeded',
        retry_after_seconds: result.retryAfterSec,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(result.retryAfterSec),
          'X-RateLimit-Remaining': String(result.remaining),
        },
      }
    )
  }

  return null
}
