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
 * Shared storage — cycle-7 `armature_vault::ou_receipt_vault`, the
 * per-(storage unit, organization) `OuReceiptVault` where an organization
 * parks warehouse receipts.
 *
 * The registry is keyed by BOTH the storage unit and the registering
 * organization, which is the single most important thing to get right here:
 * there is no such thing as "the vault at this hub". Anyone on an OU's board
 * can register a vault at any SSU, so resolving by storage unit alone will
 * happily hand back a stranger's vault. Every lookup takes both halves.
 *
 * Being keyed under an organization also does not mean that organization
 * controls the vault — `edit` principals are independent of the registrant by
 * design, so read the ACL rather than inferring authority from the key.
 */

/** Module path of the receipt vault inside `armature_vault`. */
const MODULE = 'ou_receipt_vault'

/** `ou_receipt_vault::VaultKey { storage_unit_id: ID, registrant_ou_id: ID }`. */
export const VaultKeyBcs = bcs.struct('VaultKey', {
  storage_unit_id: bcs.Address,
  registrant_ou_id: bcs.Address,
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
 * package version that created them, so after any upgrade the current id here
 * finds nothing and reports "no vault" for a vault that exists.
 */
export async function resolveOuVaultId(
  suiClient: ClientWithCoreApi,
  ids: PackageIds,
  params: { storageUnitId: string; registrantOrgId: string },
): Promise<string | null> {
  const registry = await suiClient.core
    .getObject({
      objectId: ids.ouReceiptVaultRegistry,
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
        type: `${ids.armatureVaultOriginal}::${MODULE}::VaultKey`,
        bcs: VaultKeyBcs.serialize({
          storage_unit_id: toStorageUnitId(params.storageUnitId),
          registrant_ou_id: params.registrantOrgId,
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
export interface OuVaultInfo {
  vaultId: string
  storageUnitId: string
  collectionId: string
  /**
   * The registry-key half the vault is CURRENTLY filed under — equal to the
   * initializer's OU unless `update_registry_key` has moved it since.
   */
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
export async function fetchOuVaultInfo(
  suiClient: ClientWithCoreApi,
  vaultId: string,
): Promise<OuVaultInfo | null> {
  const res = await suiClient.core
    .getObject({ objectId: vaultId, include: { json: true } })
    .catch(() => null)
  const raw = (res?.object.json ?? null) as Record<string, unknown> | null
  if (!raw) return null
  const json = (raw.fields as Record<string, unknown> | undefined) ?? raw

  const aclMap = (json.acl as Record<string, unknown>) ?? {}
  const contents =
    (aclMap.contents as unknown[]) ??
    ((aclMap.fields as Record<string, unknown>)?.contents as unknown[]) ??
    []

  const acl: OuVaultInfo['acl'] = []
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
    registrantOrgId: String(json.registrant_ou_id ?? ''),
    nonEmptyAssets: Number(json.non_empty_assets ?? 0),
    acl,
  }
}

/**
 * @internal — a Move enum's variant name and payload, across the shapes the
 * transports use: gRPC JSON `{ "@variant": "Ou", ou_id }`, JSON-RPC
 * `{ variant: "Ou", fields: { ou_id } }`, an externally tagged
 * `{ Ou: { ou_id } }`, or a bare variant name for a field-less variant.
 */
function enumVariant(
  value: unknown,
): { name: string; fields: Record<string, unknown> } | null {
  if (typeof value === 'string') return { name: value, fields: {} }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const tag = o['@variant'] ?? o.variant ?? o.$kind
  if (typeof tag === 'string') {
    const fields =
      (o.fields as Record<string, unknown> | undefined) ??
      (o[tag] as Record<string, unknown> | undefined) ??
      o
    return { name: tag, fields: fields ?? {} }
  }
  const inner = (o.fields as Record<string, unknown> | undefined) ?? o
  const keys = Object.keys(inner)
  if (keys.length === 1) {
    const payload = inner[keys[0]]
    return {
      name: keys[0],
      fields:
        payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>)
          : {},
    }
  }
  return null
}

/** @internal — `ou_receipt_vault::Role { Deposit, Withdraw, Edit }`. */
function parseRole(value: unknown): VaultRole | null {
  const lower = enumVariant(value)?.name.toLowerCase()
  return ROLE_NAMES.find((r) => r === lower) ?? null
}

/**
 * @internal — `acl::Principal { Player { addr }, Ou { ou_id }, Machine { addr } }`.
 *
 * `machine` is kept distinct from `player` even though both are satisfied by
 * the same sender check: they are different on-chain values, so a revoke has
 * to name the right one.
 */
function parsePrincipal(value: unknown): VaultPrincipal | null {
  const v = enumVariant(value)
  if (!v) return null
  const name = v.name.toLowerCase()
  if (name === 'ou' && typeof v.fields.ou_id === 'string') {
    return { kind: 'ou', value: v.fields.ou_id }
  }
  if (
    (name === 'player' || name === 'machine') &&
    typeof v.fields.addr === 'string'
  ) {
    return { kind: name, value: v.fields.addr }
  }
  return null
}

/**
 * One asset's balance in a vault, or 0n.
 *
 * Balances are dynamic OBJECT fields keyed by the `u64` asset id, so the field
 * name on-chain is `dynamic_object_field::Wrapper<u64>` and its value is the
 * child `multicoin::Balance` object — read through `getDynamicObjectField`.
 */
export async function fetchVaultBalance(
  suiClient: ClientWithCoreApi,
  vaultId: string,
  assetId: bigint,
): Promise<bigint> {
  const res = await suiClient.core
    .getDynamicObjectField({
      parentId: vaultId,
      name: { type: 'u64', bcs: bcs.u64().serialize(assetId).toBytes() },
      include: { content: true },
    })
    .catch(() => null)
  const content = res?.object.content
  if (!content) return 0n
  try {
    return BigInt(MultiCoinBalanceBcs.parse(content).amount)
  } catch {
    return 0n
  }
}

// ─── PTB helpers ────────────────────────────────────────────────────────────

/** @internal — one `Principal` built by its `acl::` constructor. */
function principalArg(
  tx: Transaction,
  armatureVault: string,
  p: VaultPrincipal,
): TransactionObjectArgument {
  switch (p.kind) {
    case 'ou':
      return tx.moveCall({
        target: `${armatureVault}::acl::ou`,
        arguments: [tx.pure.id(p.value)],
      })
    case 'machine':
      return tx.moveCall({
        target: `${armatureVault}::acl::machine`,
        arguments: [tx.pure.address(p.value)],
      })
    case 'player':
      return tx.moveCall({
        target: `${armatureVault}::acl::player`,
        arguments: [tx.pure.address(p.value)],
      })
  }
}

/**
 * Build a `vector<Principal>` inside the PTB.
 *
 * `Principal` is a Move enum with no primitive encoding, so it CANNOT cross as
 * `tx.pure()`. Each element has to be constructed by a `moveCall`
 * (`acl::player` / `acl::ou` / `acl::machine`) and collected with
 * `makeMoveVec`. This helper exists so no caller ever has to discover that the
 * hard way.
 */
export function principalVec(
  tx: Transaction,
  armatureVault: string,
  principals: VaultPrincipal[],
): TransactionObjectArgument {
  return tx.makeMoveVec({
    type: `${armatureVault}::acl::Principal`,
    elements: principals.map((p) => principalArg(tx, armatureVault, p)),
  })
}

/** @internal — `Role` is a Move enum; build it with its constructor. */
function roleArg(tx: Transaction, armatureVault: string, role: VaultRole) {
  return tx.moveCall({
    target: `${armatureVault}::${MODULE}::role_${role}`,
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
    type: `${armatureVault}::${MODULE}::Role`,
    elements: roles.map((r) => roleArg(tx, armatureVault, r)),
  })
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/**
 * Register a new vault for an organization at a storage unit
 * (`initialize_ou_vault`).
 *
 * The caller must be a board member of `registrantOrgId`; no
 * `OwnerCap<StorageUnit>` is needed (cycle 7 dropped that variant), so the SSU
 * owner and the OU board member may be different accounts. `vaultConfigId` is
 * the hub's `warehouse_receipts::vault::VaultConfig`, which fixes the accepted
 * collection. `editPrincipals` must be non-empty (`EEmptyEditPrincipals`); any
 * principal kind may hold `edit`.
 */
export function initializeOuVaultTx(
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
    target: `${args.armatureVault}::${MODULE}::initialize_ou_vault`,
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
 * `ouId` is the caller's OU context — the unit whose board membership
 * satisfies the `deposit` role. A bare `player`/`machine` deposit principal is
 * satisfied by any `&OU`, so the argument is still required even then.
 */
export function depositReceiptTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    ouId: string
    balance: TransactionObjectArgument
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::deposit_receipt`,
    arguments: [tx.object(args.vaultId), tx.object(args.ouId), args.balance],
  })
}

/** Withdraw a receipt balance from a vault; the caller routes the result. */
export function withdrawReceiptTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    ouId: string
    assetId: bigint
    amount: bigint
  },
): TransactionObjectArgument {
  const [balance] = tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::withdraw_receipt`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.ouId),
      tx.pure.u64(args.assetId),
      tx.pure.u64(args.amount),
    ],
  })
  return balance
}

/**
 * Grant (role, principal) pairs. Parallel vectors, same length. Any role —
 * `edit` included — may go to any principal kind.
 */
export function grantTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    editorOuId: string
    grants: { role: VaultRole; principal: VaultPrincipal }[]
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::grant`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.editorOuId),
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
 * Grant the `edit` role to an organization through a live `&OU` witness.
 *
 * `grantTx` accepts an `ou` editor too since cycle 7; this path additionally
 * proves the id names a REAL organization (the PTB will not even resolve
 * otherwise), so a typo cannot become an unsatisfiable editor.
 */
export function grantEditOuTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    editorOuId: string
    targetOuId: string
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::grant_edit_ou`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.editorOuId),
      tx.object(args.targetOuId),
    ],
  })
}

/**
 * Revoke (role, principal) pairs.
 *
 * Aborts `ELastEditor` if `edit` would end up empty, and
 * `EEditorWouldLockSelf` if the caller could no longer satisfy `edit` through
 * `editorOuId` afterwards. Pairs that are not present are skipped silently —
 * a `player(A)` revoke does NOT remove `machine(A)`, they are distinct values.
 */
export function revokeTx(
  tx: Transaction,
  args: {
    armatureVault: string
    vaultId: string
    editorOuId: string
    revocations: { role: VaultRole; principal: VaultPrincipal }[]
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::revoke`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.editorOuId),
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

/**
 * Re-file a vault under a different registrant organization — after an OU
 * migration, so `resolve()` finds it under the new unit. Does NOT touch the
 * ACL. Aborts if the new key is already taken.
 */
export function updateRegistryKeyTx(
  tx: Transaction,
  args: {
    armatureVault: string
    registryId: string
    vaultId: string
    editorOuId: string
    newRegistrantOrgId: string
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::update_registry_key`,
    arguments: [
      tx.object(args.registryId),
      tx.object(args.vaultId),
      tx.object(args.editorOuId),
      tx.object(args.newRegistrantOrgId),
    ],
  })
}

/**
 * Retire an EMPTY vault (`deinitialize_ou_vault`): frees its registry slot and
 * wipes its ACL. The shared object itself remains as an inert orphan.
 */
export function deinitializeOuVaultTx(
  tx: Transaction,
  args: {
    armatureVault: string
    registryId: string
    vaultId: string
    editorOuId: string
  },
): void {
  tx.moveCall({
    target: `${args.armatureVault}::${MODULE}::deinitialize_ou_vault`,
    arguments: [
      tx.object(args.registryId),
      tx.object(args.vaultId),
      tx.object(args.editorOuId),
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
