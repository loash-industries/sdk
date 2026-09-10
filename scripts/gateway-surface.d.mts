export interface GatewayQueryParam {
  name: string
  required: boolean
}

export interface GatewayOperation {
  /** Path template as the gateway publishes it, e.g. `/v1/hubs/{hub_id}/items`. */
  path: string
  /** Path with every parameter reduced to `{}`, for cross-dialect comparison. */
  normalized: string
  method: string
  operationId: string | undefined
  query: GatewayQueryParam[]
  pathParams: string[]
}

export interface SdkCall {
  /** Path as written in the source, interpolations left as `${}`. */
  path: string
  normalized: string
  method: string
  /** Query keys, or undefined when they could not be read statically. */
  query: string[] | undefined
  /** True when the path or query is not a literal, so it cannot be checked. */
  dynamic: boolean
  file: string
  line: number
}

export interface GatewayDiff {
  /** Called by the SDK, absent from the contract — a 404 waiting to happen. */
  unknownEndpoints: (SdkCall & { candidates: string[] })[]
  /** Sent by the SDK, not declared by the endpoint — silently ignored. */
  unknownParams: (SdkCall & { param: string; declared: string[] })[]
  /** Declared required, never sent. */
  missingRequired: (SdkCall & { param: string })[]
  /** Call sites too dynamic to check. */
  unverifiable: SdkCall[]
  matched: (SdkCall & { operationId: string | undefined })[]
  /** Published but unwrapped — informational only. */
  unusedEndpoints: GatewayOperation[]
}

export declare const SPEC_FIXTURE: string
export declare const SPEC_URL: string

export declare function normalizePath(path: string): string
export declare function loadSpec(specPath?: string): any
export declare function fetchSpec(url?: string): Promise<any>
export declare function readGatewaySurface(spec?: any): GatewayOperation[]
export declare function readSdkCalls(
  files?: string[],
  methodNames?: Record<string, string>,
): SdkCall[]
export declare function diffGateway(
  surface: GatewayOperation[],
  calls: readonly SdkCall[],
  options?: { allowedExtraParams?: readonly string[] },
): GatewayDiff
