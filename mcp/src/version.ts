import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Package version, read from the manifest at startup.
 *
 * This mirrors `@trinaryex/sdk` exactly: releases are cut from the SDK's
 * version, so an MCP version always names the SDK it wraps.
 */
export function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = readFileSync(join(here, '..', 'package.json'), 'utf8')
    return (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
