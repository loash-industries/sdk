/** JSON replacer that renders bigints as decimal strings. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** Serialize any SDK value to JSON text, with u64-ish values as strings. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, bigintSafe, 2)
}

export interface ToolResponse {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

/** Wrap a value as a successful MCP tool result. */
export function ok(value: unknown): ToolResponse {
  return { content: [{ type: 'text', text: toJsonText(value) }] }
}

/**
 * Wrap an error as an MCP tool result. Tool-level failures are returned as
 * results (not protocol errors) so the model can read and react to them.
 */
export function fail(error: unknown): ToolResponse {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined
  return {
    content: [
      {
        type: 'text',
        text: toJsonText({ error: message, ...(code ? { code } : {}) }),
      },
    ],
    isError: true,
  }
}
