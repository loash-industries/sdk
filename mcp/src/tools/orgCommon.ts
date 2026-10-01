import { z } from 'zod'
import { NothingToPrepare, captureTransaction } from '../capture.js'
import { extractTargets, toPrepared } from '../prepare.js'
import type { PreparedIntent } from '../prepare.js'
import type { RequestContext } from '../context.js'
import { ok } from '../result.js'
import type { ToolResponse } from '../result.js'
import { objectId, suiAddress } from '../schemas.js'

/**
 * Shared plumbing for the Armature prepare tools (`orgPrepare.ts`,
 * `orgLifecycle.ts`).
 *
 * A governance action does not have a fixed outcome. The SAME call executes in
 * one transaction for an officer whose lone vote clears quorum, creates a
 * proposal for someone whose does not, and is refused outright for a third
 * caller who holds no seat. The prepared bytes therefore carry an `outcome`
 * saying which of those the bytes will do, and a `blocked` result returns
 * `prepared: false` with the reason rather than an error.
 */

export const PREPARE_SUFFIX =
  ' Returns unsigned transaction bytes — this server never signs or submits. Verify the returned intent against the bytes, then sponsor, sign and submit with your own key.'

const GOVERNANCE_NOTE =
  'Governance actions resolve per caller: intent.outcome is "executed" when your single vote passes it now, or "proposed" when the board must vote first. prepared:false means no path was available and the reason says why.'

const PROPOSED_NOTE =
  'outcome is "proposed": these bytes CREATE a proposal — nothing has happened yet. The proposal id is a created object in the effects once submitted; the board then votes (prepare_org_vote) and a member executes it (prepare_org_execute_proposal).'

export const actingShape = {
  orgId: objectId.describe(
    'Organization object id — the root or any unit in its tree.',
  ),
  sender: suiAddress.describe(
    'Sui address the transaction is built for; only this address can sign it. Also the address whose board seat is resolved.',
  ),
  seat: objectId
    .optional()
    .describe(
      'Unit id to act THROUGH (whose board votes). Defaults to the caller’s highest-authority seat.',
    ),
}

export const ACTING_SYNTHETIC = {
  orgId:
    'Names the organization whose handle is opened; the SDK reads it from client.org(id).',
  sender:
    'The address a prepared transaction is built for, and whose seat is resolved; per-request because this server is keyless and multi-tenant.',
  seat: 'Which unit to act through; the SDK takes it from the handle.',
}

/**
 * `RunOptions` — what every cycle-7 governance write accepts beside its own
 * parameters.
 */
export const runOptionsShape = {
  unitId: objectId
    .optional()
    .describe(
      'The unit to act ON (default: the acting seat). A parent’s board can target a child it does not sit on — the action then routes through the parent’s SubOUControl.',
    ),
  metadataIpfs: z
    .string()
    .min(1)
    .optional()
    .describe(
      'IPFS reference recorded on the proposal (ProposalCreated.metadata_ipfs). Upload it first — this server hosts nothing.',
    ),
}

/** Pick the `RunOptions` out of a tool's arguments. */
export const runOptions = (args: {
  unitId?: string
  metadataIpfs?: string
}): { unitId?: string; metadataIpfs?: string } => ({
  unitId: args.unitId,
  metadataIpfs: args.metadataIpfs,
})

const bps = z.number().int().min(0).max(10000)

/** `ProposalConfigInput` — one type's voting rules, as a nested object. */
export const proposalConfig = z.object({
  quorum: bps.describe('Share of the WHOLE board that must vote, in bps.'),
  approvalThreshold: bps.describe('Share of CAST votes that must approve.'),
  proposeThreshold: z.number().int().min(0),
  expiryMs: z.number().int().min(0),
  executionDelayMs: z.number().int().min(0),
  cooldownMs: z.number().int().min(0),
  composableAllowed: z.boolean().optional(),
  permissions: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'armature::permissions bits the type’s requests carry. Any high-impact bit needs approvalThreshold ≥ 8000.',
    ),
  borrowScope: z
    .array(z.string())
    .optional()
    .describe('Capability Move types a VAULT_BORROW type may borrow.'),
})

/**
 * The same rules FLATTENED onto the tool input, for the tools whose SDK method
 * takes a required nested `config`. A flat schema is materially easier for a
 * tool caller to get right than a nested one.
 */
export const flatConfigShape = {
  quorum: bps,
  approvalThreshold: bps,
  proposeThreshold: z.number().int().min(0).default(0),
  expiryMs: z.number().int().min(0),
  executionDelayMs: z.number().int().min(0).default(0),
  cooldownMs: z.number().int().min(0).default(0),
  permissions: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'armature::permissions bits (any high-impact bit needs approvalThreshold ≥ 8000).',
    ),
  borrowScope: z
    .array(z.string())
    .optional()
    .describe('Capability Move types a VAULT_BORROW type may borrow.'),
}

const FLAT = 'Flattened into the SDK’s nested `config`.'
export const FLAT_CONFIG_SYNTHETIC = {
  quorum: FLAT,
  approvalThreshold: FLAT,
  proposeThreshold: FLAT,
  expiryMs: FLAT,
  executionDelayMs: FLAT,
  cooldownMs: FLAT,
  permissions: FLAT,
  borrowScope: FLAT,
}

/** Reassemble {@link flatConfigShape} inputs into a `ProposalConfigInput`. */
export function assembleConfig(args: {
  quorum: number
  approvalThreshold: number
  proposeThreshold?: number
  expiryMs: number
  executionDelayMs?: number
  cooldownMs?: number
  composableAllowed?: boolean
  permissions?: number
  borrowScope?: string[]
}) {
  return {
    quorum: args.quorum,
    approvalThreshold: args.approvalThreshold,
    proposeThreshold: args.proposeThreshold ?? 0,
    expiryMs: args.expiryMs,
    executionDelayMs: args.executionDelayMs ?? 0,
    cooldownMs: args.cooldownMs ?? 0,
    ...(args.permissions !== undefined
      ? { permissions: args.permissions }
      : {}),
    ...(args.borrowScope !== undefined
      ? { borrowScope: args.borrowScope }
      : {}),
  }
}

/** A vault ACL subject. `machine` is checked like `player` but is a distinct value. */
export const vaultPrincipal = z.object({
  kind: z
    .enum(['player', 'machine', 'ou'])
    .describe(
      '"player" (a wallet), "machine" (a bot/service key — a distinct principal from player for the same address), or "ou" (any board member of that organization unit).',
    ),
  value: suiAddress.describe(
    'Wallet / machine address, or organization unit id for "ou".',
  ),
})

/** Open the organization handle a prepare tool acts through. */
export const openOrg = (
  ctx: RequestContext,
  args: { orgId: string; sender: string; seat?: string },
) => ctx.writeClient(args.sender).org(args.orgId, { seat: args.seat })

/**
 * Move calls that CREATE a proposal rather than carry an action out. Anything
 * else a governance write builds executes in the same transaction
 * (`submit_vote_execute*`, a control path's privileged submit, a plain
 * cap-holder or member-gated call).
 */
const PROPOSING_TARGET =
  /::board_voting::submit_proposal$|::composite::submit_composite$/

/**
 * What a prepared governance transaction will do, read off the bytes.
 *
 * The SDK's `run()` decides between executing and proposing, but under the
 * capture executor it never returns — the build is intercepted before the
 * `RunOutcome` is shaped — so the answer is taken from the transaction itself.
 * That is the stronger evidence anyway: it is what the signer will commit to.
 */
export function outcomeOf(targets: string[]): 'executed' | 'proposed' {
  return targets.some((t) => PROPOSING_TARGET.test(t)) ? 'proposed' : 'executed'
}

type Outcome = { status: string; code?: string; reason?: string }

/**
 * Run a governance write with the capture executor and serialize the result.
 *
 * The SDK returns `RunOutcome` rather than throwing on a refusal, so a blocked
 * action produces no transaction at all — reported as `prepared: false`, the
 * same shape the trading tools use for "nothing to do". Non-governance writes
 * (permissionless, cap-holder or member-gated) go through here too and always
 * report `executed`.
 */
export async function preparedGovernance(
  ctx: RequestContext,
  sender: string,
  action: string,
  params: Record<string, unknown>,
  run: () => Promise<Outcome | unknown>,
): Promise<ToolResponse> {
  let returned: Outcome | undefined
  try {
    const tx = await captureTransaction(async () => {
      returned = (await run()) as Outcome | undefined
      return returned
    })
    const outcome = outcomeOf(extractTargets(tx))
    const intent: Omit<PreparedIntent, 'targets'> & { outcome: string } = {
      action,
      outcome,
      params: { ...params, outcome },
    }
    return ok(
      await toPrepared(
        tx,
        sender,
        ctx.suiClient(),
        intent,
        outcome === 'proposed'
          ? [GOVERNANCE_NOTE, PROPOSED_NOTE]
          : [GOVERNANCE_NOTE],
      ),
    )
  } catch (e) {
    if (e instanceof NothingToPrepare) {
      // A blocked resolution never reaches the executor, so there is nothing to
      // capture — surface the resolver's reason, which is the useful answer.
      const blocked = returned
      return ok({
        prepared: false,
        reason:
          blocked?.status === 'blocked'
            ? blocked.reason
            : 'No transaction is needed for this action in its current state.',
        code: blocked?.code ?? null,
        detail: e.result ?? null,
      })
    }
    throw e
  }
}

/**
 * Deep-convert SDK values JSON cannot carry: `Map` → object, `Set` → array.
 * Bigints are left for `toJsonText`, which renders them as decimal strings.
 */
export function plain(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [String(k), plain(v)]),
    )
  }
  if (value instanceof Set) return [...value].map(plain)
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, plain(v)]),
    )
  }
  return value
}
