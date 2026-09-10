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
  handler: (ctx: RequestContext, args: any) => Promise<ToolResponse>
}
