/**
 * Centralized environment access helpers.
 * Keeps default values and parsing logic in one place while preserving current behavior.
 */

export const DEFAULT_RAG_ID = process.env.DEFAULT_RAG_ID || 'default'
export const DEFAULT_PUBLIC_RAG_ID = process.env.NEXT_PUBLIC_RAG_ID || 'default'
export const DEFAULT_PUBLIC_AGENT_ID = process.env.NEXT_PUBLIC_AGENT_ID || 'research-twin-local'
export const DEFAULT_RAG_TOP_K = Number.parseInt(process.env.RAG_TOP_K || '5', 10)
export const DEFAULT_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)
export const DEFAULT_AGENT_TASK_TTL_MS = Number.parseInt(process.env.AGENT_TASK_TTL_MS || '900000', 10)
