import { createHash } from 'node:crypto'

/**
 * Header and field names that must never reach a log line. The tenancy test
 * asserts this list is honoured.
 */
const REDACTED_KEYS = new Set([
  'x-api-key',
  'authorization',
  'apikey',
  'api_key',
  'cookie',
  'set-cookie',
])

/**
 * A stable, non-reversible tenant label for metrics and logs.
 *
 * Truncated SHA-256 — enough to correlate a caller's requests, useless for
 * recovering the key.
 */
export function tenantLabel(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
}

/** Strip credential-bearing entries from an object before logging it. */
export function redact(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : val
  }
  return out
}

export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    message,
    ts: new Date().toISOString(),
    ...redact(fields),
  })
  if (level === 'error') console.error(line)
  else console.log(line)
}
