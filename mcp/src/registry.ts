import { coinTools } from './tools/coins.js'
import { coinPrepareTools } from './tools/coinsPrepare.js'
import { keyspaceTools } from './tools/keyspace.js'
import { orgTools } from './tools/org.js'
import { orgPrepareTools } from './tools/orgPrepare.js'
import { prepareTools } from './tools/prepare.js'
import { readTools } from './tools/read.js'
import { worldTools } from './tools/world.js'
import type { ToolDef } from './tools/types.js'
import type { ServerMode } from './env.js'

/** Every tool this server can expose, in a stable order. */
export const ALL_TOOLS: ToolDef[] = [
  ...readTools,
  ...worldTools,
  ...coinTools,
  ...keyspaceTools,
  ...orgTools,
  ...prepareTools,
  ...coinPrepareTools,
  ...orgPrepareTools,
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
  'coins.resolvePool':
    'Internal plumbing — every coins_* and prepare_coin_* tool takes the pool selector and resolves it itself; coins_list (market.poolId and coin types) and coins_orderbook already answer "which pool trades this pair".',
  'keyspace.hasAccess':
    'A membership check callable from the readPrincipals that keyspace_get_acl already returns; add a tool if callers want it server-side.',
  'keyspace.getStaleEntries':
    'Staleness is already reported per entry by keyspace_get_acl, which returns EntryMeta.isStale for every entry.',
  'keyspace.isEntryStale':
    'Single-entry form of keyspace.getStaleEntries; same reason — keyspace_get_acl already carries isStale.',

  // ─── Armature ─────────────────────────────────────────────────────────────
  //
  // The generic governance entry points take an `OuProposalAction`: an object
  // carrying `buildPayload` / `buildExecute` CLOSURES that write Move calls
  // into a transaction. That cannot cross a JSON boundary, and faking it with a
  // string enum would just be the typed tools with a worse name. The typed
  // wrappers ARE the tool surface — every `prepare_org_*` tool below builds one
  // of these actions and hands it to `run` internally.
  'org.governance.run':
    'Takes an OuProposalAction (closure-bearing); the typed prepare_org_* tools are its JSON-expressible surface.',
  'org.governance.runBatch':
    'Takes OuProposalAction[]; its only real caller is types.enableTrading, which has its own tool.',
  'org.governance.runComposite':
    'Takes OuProposalAction[] to bundle into one proposal; no JSON encoding for the actions. Revisit if a caller needs agent-driven composites.',
  'org.governance.resolve':
    'Dry-run over an OuProposalAction. The same answer is reachable from org_governance (the type configs) plus org_seats (the boards).',
  'org.governance.paths':
    'Full strategy trace over an OuProposalAction — a debugging view of resolve(); same encoding problem.',
  'org.governance.canComposite':
    'Eligibility check over OuProposalAction[]; same encoding problem as runComposite.',
  'org.governance.proposals':
    'Handle-scoped duplicate of orgs.proposals, which org_proposals already wraps without needing an acting address.',

  // Pure derivations over one org_get, deliberately not multiplied into tools.
  'orgs.nodes':
    'orgs.get flattened into a node list; org_get already returns the tree the flattening walks.',
  'orgs.seat':
    'Singular form of orgs.seats — org_seats returns them highest-authority first, so the first entry is this.',
}

/**
 * Tools for a given server mode. `read` mode never even registers the prepare
 * tools, so a read-only deployment is read-only by construction and its
 * `tools/list` says so.
 */
export function toolsForMode(mode: ServerMode): ToolDef[] {
  return mode === 'read'
    ? [...readTools, ...worldTools, ...coinTools, ...keyspaceTools, ...orgTools]
    : ALL_TOOLS
}
