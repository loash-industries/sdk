import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { Transaction } from '@mysten/sui/transactions'

/**
 * A prepared, unsigned transaction. This is the whole output contract of every
 * `prepare_*` tool: bytes the caller can sponsor, sign and submit, plus the
 * declared intent those bytes are meant to be checked against.
 *
 * Callers MUST verify before signing: decode `txKindBytes`, confirm the Move
 * call targets equal `intent.targets`, bound the spend against
 * `intent.worstCaseSpend`, and dry-run. Never blind-sign.
 */
export interface PreparedTransaction {
  /** Base64 BCS `TransactionKind`, built with `onlyTransactionKind: true`. */
  txKindBytes: string
  /** Address the transaction was built for; only this key can sign it. */
  sender: string
  intent: PreparedIntent
  /**
   * Owned/shared objects the build pinned, with the versions it resolved.
   * Staleness lives here: sign promptly, and never hold two prepared
   * transactions over the same owned objects.
   */
  pinnedObjects: PinnedObject[]
  /** Epoch-ms the bytes were built, for freshness checks. */
  builtAtMs: number
  /** Guidance echoed to the model so the constraint travels with the data. */
  notes: string[]
}

export interface PreparedIntent {
  /** Stable action name, matching the tool that produced it. */
  action: string
  /**
   * Every Move call target in the built transaction, in command order.
   * Extracted from the transaction itself — not reconstructed — so the
   * caller's allowlist check is checking the real bytes.
   */
  targets: string[]
  /** Worst-case funds the transaction can move out of the sender's control. */
  worstCaseSpend?: WorstCaseSpend
  /** Action-specific, human- and machine-readable parameters. */
  params: Record<string, unknown>
}

export interface WorstCaseSpend {
  /** Coin type or asset id, e.g. a CRED coin type or an item asset id. */
  asset: string
  /** Integer base units, as a decimal string. */
  amount: string
  kind: 'currency' | 'item'
}

export interface PinnedObject {
  objectId: string
  version: string | null
  kind: 'owned' | 'shared' | 'receiving'
}

/** Narrow view of `Transaction#getData()` — typed loosely upstream. */
interface TransactionDataSnapshot {
  commands?: unknown[]
  inputs?: unknown[]
}

/**
 * Pull every Move call target out of a built transaction, in command order.
 * Returns `<package>::<module>::<function>` strings.
 *
 * Package ids are NORMALIZED to full 32-byte form by the builder (`0x2`
 * becomes `0x000…002`). Callers allowlisting these targets must normalize
 * their expected ids the same way or the comparison will never match.
 */
export function extractTargets(tx: Transaction): string[] {
  const data = tx.getData() as TransactionDataSnapshot
  const targets: string[] = []
  for (const command of data.commands ?? []) {
    const call = (command as Record<string, any>)?.MoveCall
    if (!call) continue
    const pkg = call.package ?? '?'
    const mod = call.module ?? '?'
    const fn = call.function ?? '?'
    targets.push(`${pkg}::${mod}::${fn}`)
  }
  return targets
}

/** Pull the object inputs a build pinned, with resolved versions. */
export function extractPinnedObjects(tx: Transaction): PinnedObject[] {
  const data = tx.getData() as TransactionDataSnapshot
  const pinned: PinnedObject[] = []
  for (const input of data.inputs ?? []) {
    const object = (input as Record<string, any>)?.Object
    if (!object) continue
    const owned = object.ImmOrOwnedObject
    const shared = object.SharedObject
    const receiving = object.Receiving
    if (owned) {
      pinned.push({
        objectId: owned.objectId,
        version: owned.version != null ? String(owned.version) : null,
        kind: 'owned',
      })
    } else if (shared) {
      pinned.push({
        objectId: shared.objectId,
        version:
          shared.initialSharedVersion != null
            ? String(shared.initialSharedVersion)
            : null,
        kind: 'shared',
      })
    } else if (receiving) {
      pinned.push({
        objectId: receiving.objectId,
        version: receiving.version != null ? String(receiving.version) : null,
        kind: 'receiving',
      })
    }
  }
  return pinned
}

const VERIFY_NOTE =
  'Verify before signing: decode txKindBytes, assert its Move call targets equal intent.targets, bound the spend against intent.worstCaseSpend, then dry-run.'
const STALENESS_NOTE =
  'Sign promptly. pinnedObjects records the object versions this build resolved; holding two prepared transactions over the same owned objects risks equivocation.'

/**
 * Serialize a built transaction into the prepare contract. Builds with
 * `onlyTransactionKind: true` — no gas data, no sender signature — which is
 * exactly the shape a gas station expects for sponsorship.
 */
export async function toPrepared(
  tx: Transaction,
  sender: string,
  client: ClientWithCoreApi,
  intent: Omit<PreparedIntent, 'targets'>,
  extraNotes: string[] = [],
): Promise<PreparedTransaction> {
  tx.setSender(sender)
  const bytes = await tx.build({ client, onlyTransactionKind: true })
  return {
    txKindBytes: Buffer.from(bytes).toString('base64'),
    sender,
    intent: { ...intent, targets: extractTargets(tx) },
    pinnedObjects: extractPinnedObjects(tx),
    builtAtMs: Date.now(),
    notes: [VERIFY_NOTE, STALENESS_NOTE, ...extraNotes],
  }
}
