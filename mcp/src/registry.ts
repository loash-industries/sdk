import { prepareTools } from './tools/prepare.js'
import { readTools } from './tools/read.js'
import type { ToolDef } from './tools/types.js'
import type { ServerMode } from './env.js'

/** Every tool this server can expose, in a stable order. */
export const ALL_TOOLS: ToolDef[] = [...readTools, ...prepareTools]

/**
 * SDK client methods deliberately not exposed as tools, with the reason.
 *
 * The parity test walks the SDK's public client surface and fails on anything
 * that is neither wrapped by a tool nor listed here — so dropping a method is
 * always a conscious, reviewed act.
 */
export const EXCLUDED_SDK_PATHS: Record<string, string> = {
  'market.resolvePool':
    'Internal plumbing — pool ids are resolved inside the tools that need them.',
  'balances.currency':
    'Wallet CRED balance is a plain Sui coin read; account_balances_at_hub covers the trading-account view.',
}

/**
 * TypeScript-`private` helpers on the SDK client namespaces.
 *
 * `private` is erased at compile time, so runtime reflection still sees these
 * on the prototype. They are not public API and are not candidates for tools.
 * If the SDK ever promotes one to public, remove it here and the parity gate
 * will demand a tool for it.
 */
export const INTERNAL_SDK_PATHS: string[] = [
  'orders.beginCancelTx',
  'orders.depositQuoteDeficit',
  'orders.ownBm',
  'orders.requirePool',
]

/**
 * Tools for a given server mode. `read` mode never even registers the prepare
 * tools, so a read-only deployment is read-only by construction and its
 * `tools/list` says so.
 */
export function toolsForMode(mode: ServerMode): ToolDef[] {
  return mode === 'read' ? readTools : ALL_TOOLS
}
