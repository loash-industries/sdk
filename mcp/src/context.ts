import { SuiGrpcClient } from '@mysten/sui/grpc'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { ReadOnlyClient, TriexClient } from '@trinaryex/sdk'
import { captureExecutor } from './capture.js'
import type { ServerConfig } from './env.js'

/**
 * Per-request state. Constructed fresh for every MCP call and discarded when
 * it completes — the server holds no cross-request tenant state at all.
 */
export interface RequestContext {
  /** The caller's TriEx API key, taken from the request headers. */
  readonly apiKey: string
  readonly config: ServerConfig
  /** A read client bound to this caller's key. */
  readClient(): ReadOnlyClient
  /**
   * A client capable of *building* writes for `sender`. Its executor is the
   * capture executor, so it can build but never submit.
   */
  writeClient(sender: string): TriexClient
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
): RequestContext {
  const sui = () => suiClientOverride ?? getSuiClient(config)
  return {
    apiKey,
    config,
    suiClient: sui,
    readClient: () =>
      new ReadOnlyClient({
        apiKey,
        network: config.network,
        ...(config.indexerUrl ? { indexerUrl: config.indexerUrl } : {}),
      }),
    writeClient: (sender: string) =>
      new TriexClient({
        suiClient: sui(),
        apiKey,
        address: sender,
        executor: captureExecutor,
        network: config.network,
        ...(config.indexerUrl ? { indexerUrl: config.indexerUrl } : {}),
      }),
  }
}
