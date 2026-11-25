import { SuiGrpcClient } from '@mysten/sui/grpc'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { ReadOnlyAclClient } from '@trinaryex/keyspace'
import { ReadOnlyClient, resolveGateway, TriexClient } from '@trinaryex/sdk'
import { captureExecutor } from './capture.js'
import type { ServerConfig } from './env.js'

/**
 * Per-request state. Constructed fresh for every MCP call and discarded when
 * it completes — the server holds no cross-request tenant state at all.
 */
export interface RequestContext {
  /**
   * The caller's API key, taken from the request headers. It belongs to the
   * configured gateway (Voidwire unless `TRIEX_GATEWAY` says otherwise).
   */
  readonly apiKey: string
  readonly config: ServerConfig
  /**
   * The EVE Frontier world this request reads, from `POST /mcp?tenant=`. Sent
   * on every indexer read; undefined leaves the gateway's default (stillness).
   */
  readonly tenant?: string
  /**
   * A read client bound to this caller's key. It carries the shared fullnode
   * client too, because `coins.*` reads (books, fees, quotes, account state)
   * are on-chain simulations rather than indexer routes.
   */
  readClient(): ReadOnlyClient
  /**
   * A client capable of *building* writes for `sender`. Its executor is the
   * capture executor, so it can build but never submit.
   *
   * Omit `sender` for fullnode reads that live only on `TriexClient` and take
   * their address per call (`orders.fees`, `account.caps`): the client then has
   * no configured identity to fall back on.
   */
  writeClient(sender?: string): TriexClient
  /**
   * A Keyspace lookup client bound to this caller's key.
   *
   * Read-only by construction: it carries no `sealClient`, `executor` or
   * `storageAdapter`, so the write and decrypt surfaces are unreachable.
   * Decryption needs a wallet signature and belongs with whoever holds the key.
   */
  keyspaceClient(): ReadOnlyAclClient
  /** The shared, credential-free Sui client used for PTB resolution. */
  suiClient(): ClientWithCoreApi
}

/**
 * The Sui client carries no credentials and is identical for every caller, so
 * one instance is shared process-wide. Everything credential-bearing is built
 * per request. This is why there is no credential-keyed cache to get wrong.
 */
let sharedSuiClient: ClientWithCoreApi | null = null

export function getSuiClient(config: ServerConfig): ClientWithCoreApi {
  if (!sharedSuiClient) {
    sharedSuiClient = new SuiGrpcClient({
      network: config.network,
      baseUrl: config.grpcUrl,
    }) as unknown as ClientWithCoreApi
  }
  return sharedSuiClient
}

/** Test seam: drop the shared client so a suite can swap transports. */
export function resetSuiClient(): void {
  sharedSuiClient = null
}

export function createContext(
  apiKey: string,
  config: ServerConfig,
  suiClientOverride?: ClientWithCoreApi,
  tenant?: string,
): RequestContext {
  const scope = tenant === undefined ? {} : { tenant }
  // Resolved once and passed to every client, so the trading and Keyspace
  // clients always agree on where this caller's key is valid.
  const gateway = resolveGateway(config.gateway, config.indexerUrl)
  const sui = () => suiClientOverride ?? getSuiClient(config)
  return {
    apiKey,
    config,
    ...scope,
    suiClient: sui,
    keyspaceClient: () =>
      new ReadOnlyAclClient({
        suiClient: sui() as never,
        apiKey,
        gateway,
        ...(config.indexerUrl ? { indexerUrl: config.indexerUrl } : {}),
      }),
    readClient: () =>
      new ReadOnlyClient({
        apiKey,
        network: config.network,
        suiClient: sui(),
        ...scope,
        gateway,
        ...(config.indexerUrl ? { indexerUrl: config.indexerUrl } : {}),
      }),
    writeClient: (sender?: string) =>
      new TriexClient({
        suiClient: sui(),
        apiKey,
        ...(sender ? { address: sender } : {}),
        executor: captureExecutor,
        network: config.network,
        ...scope,
        gateway,
        ...(config.indexerUrl ? { indexerUrl: config.indexerUrl } : {}),
      }),
  }
}
