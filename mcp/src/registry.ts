import { keyspaceTools } from './tools/keyspace.js'
import { prepareTools } from './tools/prepare.js'
import { readTools } from './tools/read.js'
import type { ToolDef } from './tools/types.js'
import type { ServerMode } from './env.js'

/** Every tool this server can expose, in a stable order. */
export const ALL_TOOLS: ToolDef[] = [
  ...readTools,
  ...keyspaceTools,
  ...prepareTools,
]

/**
 * Inputs any tool may declare without an SDK counterpart.
 *
 * `sender` is the only word this server adds to the SDK's vocabulary, and it
 * exists precisely because the server is keyless: the SDK takes the signing
 * address from client configuration, whereas here every request names the
 * address its transaction is built for. That is what lets one instance serve a
 * whole fleet without holding anyone's key.
 */
export const GLOBAL_SYNTHETIC_PARAMS: Record<string, string> = {
  sender:
    'The address a prepared transaction is built for; per-request because this server is keyless and multi-tenant.',
}

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
  'keyspace.hasAccess':
    'A membership check callable from the readPrincipals that keyspace_get_acl already returns; add a tool if callers want it server-side.',
  'keyspace.getStaleEntries':
    'Staleness is already reported per entry by keyspace_get_acl, which returns EntryMeta.isStale for every entry.',
  'keyspace.isEntryStale':
    'Single-entry form of keyspace.getStaleEntries; same reason — keyspace_get_acl already carries isStale.',
  'balances.currency':
    'Wallet CRED balance is a plain Sui coin read; account_balances_at_hub covers the trading-account view.',
}

/**
 * Tools for a given server mode. `read` mode never even registers the prepare
 * tools, so a read-only deployment is read-only by construction and its
 * `tools/list` says so.
 */
export function toolsForMode(mode: ServerMode): ToolDef[] {
  return mode === 'read' ? [...readTools, ...keyspaceTools] : ALL_TOOLS
}
