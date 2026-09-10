import type { TriexNetwork } from '@trinaryex/sdk'

export type ServerMode = 'read' | 'prepare'

export interface ServerConfig {
  host: string
  port: number
  /** `read` registers read tools only; `prepare` adds the prepare tools. */
  mode: ServerMode
  network: TriexNetwork
  /** Sui fullnode gRPC base URL used for object resolution and PTB builds. */
  grpcUrl: string
  /** Indexer base URL override; the SDK default applies when unset. */
  indexerUrl?: string
  /** Max concurrent in-flight tool calls per API key. Fairness, not security. */
  maxConcurrencyPerKey: number
  tls?: { certPath: string; keyPath: string }
}

const DEFAULT_GRPC_URL = 'https://fullnode.testnet.sui.io:443'

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return parsed
}

/**
 * Read server configuration from the environment.
 *
 * Note what is absent: no API key, no address, no private key, no database.
 * Everything here is non-secret. Credentials arrive per request (see
 * `context.ts`) and are never stored.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = (env.TRIEX_MCP_MODE ?? 'prepare') as ServerMode
  if (mode !== 'read' && mode !== 'prepare') {
    throw new Error(`TRIEX_MCP_MODE must be "read" or "prepare", got: ${mode}`)
  }

  const certPath = env.TLS_CERT_PATH
  const keyPath = env.TLS_KEY_PATH
  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be set together')
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port: intFromEnv('PORT', 8080),
    mode,
    network: (env.TRIEX_NETWORK ?? 'testnet') as TriexNetwork,
    grpcUrl: env.SUI_GRPC_URL ?? DEFAULT_GRPC_URL,
    ...(env.TRIEX_API_URL ? { indexerUrl: env.TRIEX_API_URL } : {}),
    maxConcurrencyPerKey: intFromEnv('MAX_CONCURRENCY_PER_KEY', 8),
    ...(certPath && keyPath ? { tls: { certPath, keyPath } } : {}),
  }
}
