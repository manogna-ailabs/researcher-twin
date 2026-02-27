/**
 * Helper utilities for normalizing agent responses before rendering in the chat UI.
 * These functions are pure and side-effect free to keep parsing logic easy to test.
 */

export function stripThinkBlocks(text: string): string {
  if (!text) return ''
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<\/think>\s*/gim, '')
    .trim()
}

export function stripJsonCodeFence(text: string): string {
  if (!text) return ''
  const trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenceMatch?.[1]) return fenceMatch[1].trim()
  return trimmed
}

export function extractFirstStructuredJson(text: string): Record<string, any> | null {
  if (!text || !text.includes('{') || !text.includes('response_text')) return null

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let end = start; end < text.length; end++) {
      const ch = text[end]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue

      if (ch === '{') depth += 1
      if (ch === '}') depth -= 1

      if (depth === 0) {
        const candidate = text.slice(start, end + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object' && typeof parsed.response_text === 'string') {
            return parsed as Record<string, any>
          }
        } catch {
          // Continue scanning.
        }
        break
      }
    }
  }

  return null
}

export function splitResponseAndMetadata(text: string): { mainText: string; metadataText: string } {
  const markers = [
    '\nPrimary evidence:',
    '\n### Evidence Notes',
    '\n### Evidence',
    '\nEvidence Notes\n',
    '\nEvidence\n',
    '\nCitations\n',
  ]

  let cutIndex = -1
  for (const marker of markers) {
    const index = text.indexOf(marker)
    if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
      cutIndex = index
    }
  }

  if (cutIndex < 0) {
    return { mainText: text.trim(), metadataText: '' }
  }

  return {
    mainText: text.slice(0, cutIndex).trim(),
    metadataText: text.slice(cutIndex).trim(),
  }
}

export function sanitizeMetadataForDisplay(text: string): string {
  if (!text) return ''
  let sanitized = text.trim()
  sanitized = sanitized.replace(/(?:^|\n)#+\s*Citations[\s\S]*$/i, '').trim()
  sanitized = sanitized.replace(/(?:^|\n)Citations\s*\n[\s\S]*$/i, '').trim()
  sanitized = sanitized.replace(/(?:^|\n)#+\s*References[\s\S]*$/i, '').trim()
  sanitized = sanitized.replace(/(?:^|\n)References\s*\n[\s\S]*$/i, '').trim()
  return sanitized
}

export function coerceAgentPayload(raw: unknown): Record<string, any> {
  let current: unknown = raw

  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === 'string') {
      const cleaned = stripJsonCodeFence(stripThinkBlocks(current))
      if (!cleaned) return {}

      const embedded = extractFirstStructuredJson(cleaned)
      if (embedded) {
        current = embedded
        continue
      }

      try {
        const parsed = JSON.parse(cleaned)
        if (parsed && typeof parsed === 'object') {
          current = parsed
          continue
        }
        if (typeof parsed === 'string') {
          current = parsed
          continue
        }
      } catch {
        return { response_text: cleaned }
      }

      return { response_text: cleaned }
    }

    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return {}
    }

    const obj = current as Record<string, any>

    if (obj.result !== undefined) {
      current = obj.result
      continue
    }

    if (obj.response !== undefined && obj.response !== obj) {
      current = obj.response
      continue
    }

    if (typeof obj.response_text === 'string') {
      const nested = coerceAgentPayload(obj.response_text)
      const nestedLooksStructured =
        typeof nested?.response_text === 'string'
        && nested.response_text !== stripJsonCodeFence(stripThinkBlocks(obj.response_text))
      if (nestedLooksStructured) {
        return {
          ...obj,
          ...nested,
          citations: Array.isArray(nested.citations) && nested.citations.length > 0 ? nested.citations : obj.citations,
          suggested_followups: Array.isArray(nested.suggested_followups) && nested.suggested_followups.length > 0
            ? nested.suggested_followups
            : obj.suggested_followups,
        }
      }
    }

    return obj
  }

  return {}
}

export function extractFollowups(source: Record<string, any>): string[] {
  const candidates = [
    source?.suggested_followups,
    source?.followups,
    source?.suggested_questions,
    source?.suggested_follow_up_questions,
    source?.next_questions,
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.map(item => String(item).trim()).filter(Boolean).slice(0, 5)
    }
  }

  return []
}
