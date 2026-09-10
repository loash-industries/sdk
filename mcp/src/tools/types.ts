import type { ZodRawShape } from 'zod'
import type { RequestContext } from '../context.js'
import type { ToolResponse } from '../result.js'

export type ToolKind = 'read' | 'prepare'

/**
 * One MCP tool. The `sdkPath` field is load-bearing: the parity test walks the
 * SDK's public client surface and fails when a method has no tool here and no
 * entry in the exclusion list, so the MCP surface cannot silently fall behind
 * the SDK it wraps.
 */
export interface ToolDef {
  name: string
  title: string
  description: string
  kind: ToolKind
  /** Dotted path of the SDK method this delegates to, e.g. `orders.limit`. */
  sdkPath: string
  inputShape: ZodRawShape
  /**
   * Inputs with no SDK counterpart, each mapped to why it exists.
   *
   * The parity gate rejects any input its SDK method does not accept, because
   * an unrecognised property is dropped in transit rather than refused — the
   * caller gets a cheerful, silently unfiltered answer. Anything legitimately
   * MCP-level belongs here, in writing.
   */
  syntheticParams?: Record<string, string>
  /**
   * Required SDK parameters the handler supplies itself instead of accepting
   * from the caller, each mapped to where the value comes from.
   */
  derivedParams?: Record<string, string>
  handler: (ctx: RequestContext, args: any) => Promise<ToolResponse>
}
