const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|session|ticket|token)/i
const BEARER_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const LABELED_VALUE = /((?:token|secret|password|cookie|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi
const JSON_SECRET_VALUE = /((?:"|')?(?:access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|secret|session[_-]?token|ticket|token)(?:"|')?\s*:\s*(?:"|'))[^"']+/gi

function sanitizeString(value: string): string {
  return value
    .replace(JSON_SECRET_VALUE, '$1[REDACTED]')
    .replace(LABELED_VALUE, '$1[REDACTED]')
    .replace(BEARER_VALUE, '$1[REDACTED]')
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (!value || typeof value !== 'object') return value
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeString(value.message) }
  }
  if (depth >= 5) return '[TRUNCATED]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, seen, depth + 1))
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(entry, seen, depth + 1),
  ]))
}

export function sanitizeLogArguments(values: unknown[]): unknown[] {
  const seen = new WeakSet<object>()
  return values.map(value => sanitizeValue(value, seen, 0))
}

export function installSafeConsole(): void {
  for (const method of ['log', 'warn', 'error'] as const) {
    const original = console[method].bind(console)
    console[method] = (...values: unknown[]) => original(...sanitizeLogArguments(values))
  }
}
