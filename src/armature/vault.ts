import { bcs } from '@mysten/sui/bcs'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type {
  Transaction,
  TransactionObjectArgument,
} from '@mysten/sui/transactions'

import { TriexClientError, TriexError } from '../errors'
import { findOwnedItemReceipts } from '../onchain'
import type { PackageIds } from '../types'
import type { VaultPrincipal, VaultRole } from './types'

/**
 * Shared storage — `DaoReceiptVault`, the per-(storage unit, organization) place
 * an organization parks warehouse receipts.
 *
 * The registry is keyed by BOTH the storage unit and the registering
 * organization, which is the single most important thing to get right here:
 * there is no such thing as "the vault at this hub". Anyone can register a
 * vault at any SSU, so resolving by storage unit alone will happily hand back a
 * stranger's vault. Every lookup in this module takes both halves of the key.
 *
 * Being keyed under an organization also does not mean that organization
 * controls the vault — `edit` principals are independent of the registrant by
 * design, so read the ACL rather than inferring authority from the key.
 */

/** `dao_receipt_vault::VaultKey { storage_unit_id: ID, registrant_dao_id: ID }`. */
export const VaultKeyBcs = bcs.struct('VaultKey', {
  storage_unit_id: bcs.Address,
  registrant_dao_id: bcs.Address,
})

/** `multicoin::Balance { id, collection, asset_id, amount }`. */
const MultiCoinBalanceBcs = bcs.struct('MultiCoinBalance', {
  id: bcs.Address,
  collection: bcs.Address,
  asset_id: bcs.u64(),
  amount: bcs.u64(),
})

/** Normalize a storage-unit id (numeric or short hex) to 0x + 64 hex. */
export function toStorageUnitId(value: string): string {
  if (/^0x/i.test(value)) {
    return `0x${value.slice(2).padStart(64, '0').toLowerCase()}`
  }
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Resolve the vault an organization registered at a storage unit, or null when
 * it has none there.
 *
 * Two hops: the registry object holds a `Table`, whose inner UID is what the
 * `VaultKey` dynamic field actually hangs off. The key TYPE must use the
 * `armature_vault` ORIGINAL package id — objects keep the type tag of the
 * package version that created them, and on `stillness` that id has already
 * diverged from the current one, so using the current id here finds nothing and
 * reports "no vault" for a vault that exists.
 */
export async function resolveDaoVaultId(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  params: { storageUnitId: string; registrantOrgId: string },
): Promise<string | null> {
  const registry = await suiClient.core
    .getObject({
      objectId: ids.daoReceiptVaultRegistry,
      include: { json: true },
    })
    .catch(() => null)
  const json = (registry?.object.json ?? null) as { vaults?: unknown } | null
  if (!json) return null

  // Unwrap the whole `vaults` field, not `vaults.id` — under JSON-RPC the
  // `.fields` layer sits ABOVE the UID, so reaching for `.id` first misses it
  // entirely and reports "no vault" for a vault that exists.
  const tableId = unwrapId(json.vaults)
  if (!tableId) return null

  const entry = await suiClient.core
    .getDynamicField({
      parentId: tableId,
      name: {
        type: `${ids.armatureVaultOriginal}::dao_receipt_vault::VaultKey`,
        bcs: VaultKeyBcs.serialize({
          storage_unit_id: toStorageUnitId(params.storageUnitId),
          registrant_dao_id: params.registrantOrgId,
        }).toBytes(),
      },
    })
    .catch(() => null)
  if (!entry) return null
  try {
    return bcs.Address.parse(entry.dynamicField.value.bcs)
  } catch {
    return null
  }
}

/** @internal — a Move `UID`/`ID` field, across both transport shapes. */
function unwrapId(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const inner = (o.fields as Record<string, unknown> | undefined) ?? o
  const id = inner.id ?? inner.bytes
  return typeof id === 'string' ? id : unwrapId(id)
}

/** A vault's on-chain identity and current access grants. */
export interface DaoVaultInfo {
  vaultId: string
  storageUnitId: string
  collectionId: string
  registrantOrgId: string
  /** Distinct asset ids currently holding a balance. */
  nonEmptyAssets: number
  acl: { role: VaultRole; principal: VaultPrincipal }[]
}

const ROLE_NAMES: VaultRole[] = ['deposit', 'withdraw', 'edit']

/**
 * Read a vault directly, rather than through `orgs.vaultsAtHub()`.
 *
 * Prefer the indexer for listing; use this when the answer has to be
 * head-current — deciding whether a `grant` already landed, for instance, where
 * the indexer's 30-second cache is exactly long enough to mislead.
 */
export async function fetchDaoVaultInfo(
  suiClient: ClientWithCoreApi,
  vaultId: string,
): Promise<DaoVaultInfo | null> {
  const res = await suiClient.core
    .getObject({ objectId: vaultId, include: { json: true } })
    .catch(() => null)
  const json = (res?.object.json ?? null) as Record<string, unknown> | null
  if (!json) return null

  const aclMap = (json.acl as Record<string, unknown>) ?? {}
  const contents =
    (aclMap.contents as unknown[]) ??
    ((aclMap.fields as Record<string, unknown>)?.contents as unknown[]) ??
    []

  const acl: DaoVaultInfo['acl'] = []
  for (const entry of contents) {
    const e = (entry as Record<string, unknown>) ?? {}
    const inner = (e.fields as Record<string, unknown>) ?? e
    const role = parseRole(inner.key)
    const principals = (inner.value as unknown[]) ?? []
    if (!role || !Array.isArray(principals)) continue
    for (const p of principals) {
      const parsed = parsePrincipal(p)
      if (parsed) acl.push({ role, principal: parsed })
    }
  }

  return {
    vaultId,
    storageUnitId: String(json.storage_unit_id ?? ''),
    collectionId: String(json.collection_id ?? ''),
    registrantOrgId: String(json.registrant_dao_id ?? ''),
    nonEmptyAssets: Number(json.non_empty_assets ?? 0),
    acl,
  }
}

/** @internal — a Move enum arrives as a variant name or a `{ variant: {} }` tag. */
function parseRole(value: unknown): VaultRole | null {
  const name =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? Object.keys(value as object)[0]
        : undefined
  const lower = name?.toLowerCase()
  return ROLE_NAMES.find((r) => r === lower) ?? null
}

/** @internal — `acl::Principal { kind: u8, id: address, data }`. */
function parsePrincipal(value: unknown): VaultPrincipal | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const inner = (o.fields as Record<string, unknown>) ?? o
  const id = inner.id
  if (typeof id !== 'string') return null
  // 0 = player, 1 = ou, 2 = machine. `machine` satisfies the same checks as a
  // player, so it is surfaced as `player` rather than inventing a third kind
  // the indexer's shape has no room for.
  return { kind: Number(inner.kind) === 1 ? 'ou' : 'player', value: id }
}

/** One asset's balance in a vault, or 0n. */
export async function fetchVaultBalance(
  suiClient: ClientWithCoreApi,
  vaultId: string,
  assetId: bigint,
): Promise<bigint> {
  const field = await suiClient.core
    .getDynamicField({
      parentId: vaultId,
      name: { type: 'u64', bcs: bcs.u64().serialize(assetId).toBytes() },
    })
    .catch(() => null)
  if (!field) return 0n
  try {
    // A dynamic OBJECT field's value is the child's id; fetch the balance.
    const parsed = MultiCoinBalanceBcs.parse(field.dynamicField.value.bcs)
    return BigInt(parsed.amount)
  } catch {
    return 0n
  }
}

// ─── PTB helpers ────────────────────────────────────────────────────────────

/**
 * Build a `vector<Principal>` inside the PTB.
 *
 * `Principal` is a Move enum-like struct with no primitive encoding, so it
 * CANNOT cross as `tx.pure()`. Each element has to be constructed by a
 * `moveCall` and collected with `makeMoveVec`. This helper exists so no caller
 * ever has to discover that the hard way.
 */
export function principalVec(
  tx: Transaction,
  armatureVault: string,
  principals: VaultPrincipal[],
): TransactionObjectArgument {
  const elements = principals.map((p) =>
    p.kind === 'ou'
      ? tx.moveCall({
          target: `${armatureVault}::acl::ou`,
          arguments: [tx.pure.id(p.value)],
        })
      : tx.moveCall({
          target: `${armatureVault}::acl::player`,
          arguments: [tx.pure.address(p.value)],
        }),
  )
  return tx.makeMoveVec({
    type: `${armatureVault}::acl::Principal`,
    elements,
  })
}

/** @internal — `Role` is a Move enum; build it with its constructor. */
function roleArg(tx: Transaction, armatureVault: string, role: VaultRole) {
  return tx.moveCall({
    target: `${armatureVault}::dao_receipt_vault::role_${role}`,
    arguments: [],
  })
}

/** Build a `vector<Role>` inside the PTB, parallel to a principal vector. */
export function roleVec(
  tx: Transaction,
  armatureVault: string,
  roles: VaultRole[],
): TransactionObjectArgument {
  return tx.makeMoveVec({
    type: `${armatureVault}::dao_receipt_vault::Role`,
    elements: roles.map((r) => roleArg(tx, armatureVault, r)),
  })
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Register a new vault for an organization at a storage unit.
 *
 * The caller must be a governance member of `registrantOrgId`, and
 * `editPrincipals` must contain at least one *recoverable* editor — an `ou`
 * principal witnessed by a live DAO. The chain enforces that: a vault whose
 * only editors were bare keys could be bricked beyond recovery, so an
 * all-`player` edit set is rejected.
 */
export function initializeDaoVaultTx(
  tx: Transaction,
  args: {
    armatureVault: string
    registryId: string
    storageUnitId: string
    registrantOrgId: string
    vaultConfigId: string
    depositPrincipals: VaultPrincipal[]
    withdrawPrincipals: VaultPrincipal[]
    editPrincipals: VaultPrincipal[]
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::initialize_dao_vault_v2`,
    arguments: [
      tx.object(args.registryId),
      tx.object(toStorageUnitId(args.storageUnitId)),
      tx.object(args.registrantOrgId),
      tx.object(args.vaultConfigId),
      principalVec(tx, args.armatureVault, args.depositPrincipals),
      principalVec(tx, args.armatureVault, args.withdrawPrincipals),
      principalVec(tx, args.armatureVault, args.editPrincipals),
    ],
  })
}

/**
 * Deposit an already-extracted receipt balance into a vault.
 *
 * `daoId` is the caller's OU context — the unit whose board membership
 * satisfies the `deposit` role. A bare `player` deposit principal is satisfied
 * by any `&DAO`, so the argument is still required even then.
 */
export function depositReceiptTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    daoId: string
    balance: TransactionObjectArgument
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::deposit_receipt`,
    arguments: [tx.object(args.vaultId), tx.object(args.daoId), args.balance],
  })
}

/** Withdraw a receipt balance from a vault; the caller routes the result. */
export function withdrawReceiptTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    daoId: string
    assetId: bigint
    amount: bigint
  },
): TransactionObjectArgument {
  const [balance] = tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::withdraw_receipt`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.daoId),
      tx.pure.u64(args.assetId),
      tx.pure.u64(args.amount),
    ],
  })
  return balance
}

/** Grant (role, principal) pairs. Parallel vectors, same length. */
export function grantTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    editorDaoId: string
    grants: { role: VaultRole; principal: VaultPrincipal }[]
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::grant`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.editorDaoId),
      roleVec(
        tx,
        args.armatureVault,
        args.grants.map((g) => g.role),
      ),
      principalVec(
        tx,
        args.armatureVault,
        args.grants.map((g) => g.principal),
      ),
    ],
  })
}

/**
 * Grant the `edit` role to an organization.
 *
 * The ONLY path that can add an `ou` editor: it requires a live `&DAO` witness,
 * which is what stops a typo'd DAO id from becoming an unsatisfiable editor and
 * bricking the vault. `grantTx` rejects `edit` + `ou` for exactly that reason.
 */
export function grantEditOuTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    editorDaoId: string
    targetDaoId: string
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::grant_edit_ou`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.editorDaoId),
      tx.object(args.targetDaoId),
    ],
  })
}

/**
 * Revoke (role, principal) pairs.
 *
 * A batch that removes NOTHING aborts rather than succeeding quietly, so an
 * operator cannot come away believing access was cut when it was not. The usual
 * cause is a kind mismatch: `player(A)` and `machine(A)` are distinct principals
 * for the same address even though both satisfy the same checks.
 */
export function revokeTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    editorDaoId: string
    revocations: { role: VaultRole; principal: VaultPrincipal }[]
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::revoke`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.editorDaoId),
      roleVec(
        tx,
        args.armatureVault,
        args.revocations.map((r) => r.role),
      ),
      principalVec(
        tx,
        args.armatureVault,
        args.revocations.map((r) => r.principal),
      ),
    ],
  })
}

/** Retire an EMPTY vault and free its registry slot. */
export function deinitializeDaoVaultTx(
  tx: Transaction,
  args: {
    armatureVault: string
    registryId: string
    vaultId: string
    editorDaoId: string
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::dao_receipt_vault::deinitialize_dao_vault`,
    arguments: [
      tx.object(args.registryId),
      tx.object(args.vaultId),
      tx.object(args.editorDaoId),
    ],
  })
}

// ─── Wallet receipt sourcing ────────────────────────────────────────────────

/**
 * Assemble exactly `amount` of one asset from the caller's wallet receipts.
 *
 * Receipts are separate objects, so covering an amount usually means joining
 * several and splitting the remainder back off. Largest-first keeps the number
 * of joins down.
 *
 * @throws `InsufficientBalance` when the wallet's receipts cannot cover it;
 *   `CollectionMismatch` when they belong to a different collection than the
 *   vault accepts.
 */
export async function sourceWalletReceipts(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  ids: PackageIds,
  params: {
    owner: string
    assetId: bigint
    amount: bigint
    collectionId: string
  },
): Promise<TransactionObjectArgument> {
  const receipts = await findOwnedItemReceipts(suiClient, ids, params.owner, {
    assetId: String(params.assetId),
  })
  const matching = receipts.filter(
    (r) => normalizeId(r.collectionId) === normalizeId(params.collectionId),
  )
  if (receipts.length > 0 && matching.length === 0) {
    throw new TriexClientError(
      TriexError.CollectionMismatch,
      `Wallet receipts for asset ${params.assetId} belong to a different collection than this vault accepts.`,
    )
  }

  const sorted = [...matching].sort((a, b) => (b.amount > a.amount ? 1 : -1))
  const chosen: typeof sorted = []
  let total = 0n
  for (const r of sorted) {
    if (total >= params.amount) break
    chosen.push(r)
    total += r.amount
  }
  if (total < params.amount) {
    throw new TriexClientError(
      TriexError.InsufficientBalance,
      `Wallet holds ${total} of asset ${params.assetId}; ${params.amount} needed.`,
    )
  }

  const primary = tx.object(chosen[0].objectId)
  for (let i = 1; i < chosen.length; i++) {
    tx.moveCall({
      target: `${ids.multicoin}::multicoin::join_entry`,
      arguments: [primary, tx.object(chosen[i].objectId)],
    })
  }
  if (total === params.amount) return primary
  const [split] = tx.moveCall({
    target: `${ids.multicoin}::multicoin::split`,
    arguments: [primary, tx.pure.u64(params.amount)],
  })
  return split
}

/** @internal */
const normalizeId = (id: string): string =>
  id.toLowerCase().replace(/^0x/, '').replace(/^0+/, '')
