import { z } from 'zod'
import { ok } from '../result.js'
import {
  big,
  cursorPagingShape,
  objectId,
  suiAddress,
  u64,
} from '../schemas.js'
import { plain } from './orgCommon.js'
import type { ToolDef } from './types.js'

/**
 * Armature organization reads: identity, governance, treasury and shared
 * storage.
 *
 * A note that shapes several of these tools. An organization is a TREE of DAOs
 * — a root plus its units — and almost every question about one is really a
 * question about a specific unit: which board votes, whose treasury, whose
 * shared storage. Any unit id resolves the whole tree, so `orgId` is forgiving,
 * but the ANSWERS are per-unit and the tools say which unit they answered for.
 *
 * `address` appears on the unit-scoped tools because a seat is per-caller: this
 * server is keyless and multi-tenant, so it cannot read an address off client
 * configuration the way the SDK does.
 */

const orgIdShape = {
  orgId: objectId.describe(
    'Organization object id — the root or ANY unit in its tree; the whole tree is returned either way.',
  ),
}

const actingShape = {
  ...orgIdShape,
  address: suiAddress.describe(
    'The acting address. Seats are per-caller and this server holds no identity, so it must be named.',
  ),
  seat: objectId
    .optional()
    .describe(
      'Unit id to act through. Defaults to the caller’s highest-authority seat.',
    ),
}

/** Open a handle for a unit-scoped read. */
const handle = (
  ctx: any,
  args: { orgId: string; address: string; seat?: string },
) => ctx.writeClient(args.address).org(args.orgId, { seat: args.seat })

export const orgTools: ToolDef[] = [
  {
    name: 'org_get',
    title: 'Get an organization',
    description:
      'Resolve an organization to its full unit tree: name, metadata, treasury, capability vault, board members per unit, and any trading account. Any unit id returns the top-level organization.',
    kind: 'read',
    sdkPath: 'orgs.get',
    inputShape: { ...orgIdShape },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.get(args.orgId)),
  },
  {
    name: 'org_batch',
    title: 'Batch-get organizations',
    description:
      'Resolve up to 200 organization ids at once, in request order. Ids that do not resolve come back with null fields and metadata.errorReason = "unresolved" rather than being dropped, so results stay index-aligned with the request.',
    kind: 'read',
    sdkPath: 'orgs.batch',
    inputShape: {
      orgIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('Organization object ids (max 200).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.batch(args.orgIds)),
  },
  {
    name: 'org_directory',
    title: 'Browse organizations',
    description:
      'One page of the discovery directory — top-level organizations only, largest first by member count unless sorted by name. Page with the returned nextCursor.',
    kind: 'read',
    sdkPath: 'orgs.directory',
    inputShape: {
      limit: z.number().int().min(1).max(50).optional(),
      cursor: cursorPagingShape.cursor,
      sort: z.enum(['members', 'name']).optional(),
    },
    handler: async (ctx, args) =>
      ok(
        await ctx.readClient().orgs.directory({
          limit: args.limit,
          cursor: args.cursor,
          sort: args.sort,
        }),
      ),
  },
  {
    name: 'org_for_player',
    title: 'Organizations an address governs',
    description:
      'Every organization the address is a current governance member of, each as a full unit tree. Use org_seats to find where within a tree the address actually sits.',
    kind: 'read',
    sdkPath: 'orgs.forPlayer',
    inputShape: {
      address: suiAddress.describe('Player wallet address.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.forPlayer(args.address)),
  },
  {
    name: 'org_search',
    title: 'Search organizations',
    description:
      'Search organization UNITS by name, organization id, or treasury id. A hit may be a unit deep in a tree, so each carries rootOrgId/rootName for labelling.',
    kind: 'read',
    sdkPath: 'orgs.search',
    inputShape: {
      q: z
        .string()
        .min(1)
        .describe('Partial name, or an exact org / treasury id.'),
      limit: z.number().int().min(1).max(50).optional(),
      enrich: z
        .boolean()
        .optional()
        .describe(
          'Resolve icons and descriptions; costs a metadata lookup per hit.',
        ),
    },
    handler: async (ctx, args) =>
      ok(
        await ctx
          .readClient()
          .orgs.search(args.q, { limit: args.limit, enrich: args.enrich }),
      ),
  },
  {
    name: 'org_proposals',
    title: 'List an organization’s proposals',
    description:
      'Governance proposals for an organization, newest first, from the indexer — including executed and expired ones, which cycle 7 deletes on-chain. Each carries the config snapshotted at submission (null if unindexed), createdMs and metadataIpfs, but NO snapshot weight, so yesWeight/noWeight have no denominator here: read org_proposal for the live tally. "pending" INCLUDES a lapsed voting window nobody cleaned up — such a proposal can only be deleted (org_expired_proposals, prepare_org_delete_expired_proposals), not voted on.',
    kind: 'read',
    sdkPath: 'orgs.proposals',
    inputShape: { ...orgIdShape },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.proposals(args.orgId)),
  },
  {
    name: 'org_seats',
    title: 'Board seats an address holds',
    description:
      'Every unit of an organization whose board the address sits on, highest authority first. An empty result means the address governs nothing there. This is what decides which actions are available and whether they execute immediately.',
    kind: 'read',
    sdkPath: 'orgs.seats',
    inputShape: {
      ...orgIdShape,
      address: suiAddress.describe('The address whose seats to resolve.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.seats(args.orgId, args.address)),
  },
  {
    name: 'org_trading_account',
    title: 'An organization’s trading account',
    description:
      'The organization’s shared TradingAccount and the unit that holds it, or null when trading was never set up. Feed the id to orders_open / orders_fills / orders_trades / account_sweepable — those take a trading account id and do not care who owns it.',
    kind: 'read',
    sdkPath: 'orgs.tradingAccount',
    inputShape: { ...orgIdShape },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.tradingAccount(args.orgId)),
  },
  {
    name: 'org_accessible_keyspaces',
    title: 'Keyspaces an address can reach, with roles',
    description:
      'Every keyspace the address can reach and HOW: created by one of their organizations, granted to them directly, or granted to one of their organizations — plus the roles held on each. Richer than keyspace_list_accessible, which returns ids only. Metadata only; decrypting needs a wallet-signed Seal session key this server cannot produce.',
    kind: 'read',
    sdkPath: 'orgs.accessibleKeyspaces',
    inputShape: {
      address: suiAddress.describe('Player wallet address.'),
      role: z.enum(['grant', 'read', 'write']).optional(),
    },
    handler: async (ctx, args) =>
      ok(
        await ctx
          .readClient()
          .orgs.accessibleKeyspaces(args.address, args.role),
      ),
  },
  {
    name: 'org_vaults_at_hub',
    title: 'Shared storage at a trade hub',
    description:
      'Active organization receipt vaults registered at a trade hub, each with its current member set per role (deposit / withdraw / edit). Note a vault is keyed by (storage unit, ORGANIZATION) — several organizations can each have one at the same hub, and one of them being here does not make it yours.',
    kind: 'read',
    sdkPath: 'orgs.vaultsAtHub',
    inputShape: {
      hubId: objectId.describe('Trade hub / storage unit object id.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().orgs.vaultsAtHub(args.hubId)),
  },

  // ─── unit-scoped reads ─────────────────────────────────────────────────────

  {
    name: 'org_governance',
    title: 'A unit’s governance rules',
    description:
      'Which proposal types a unit has enabled and the voting rules for each: quorum and approval in basis points, expiry, execution delay, composability, permission bits and borrow scope; plus every slot keyed by Move type (with its last execution), the unit’s lifecycle and pause flags (state: migrating, executionPaused, controllerPaused, memberCount, encryptEpoch) and its freeze state. This is what decides whether an action executes in one transaction or becomes a proposal — a lone vote clears quorum only when boardSize × quorum ≤ 10000 and the execution delay is zero.',
    kind: 'read',
    sdkPath: 'org.governance.read',
    inputShape: { ...actingShape },
    syntheticParams: {
      orgId:
        'Names the organization whose handle is opened; the SDK reads it from client.org(id).',
      address:
        'The acting address; per-request because this server is keyless and multi-tenant.',
      seat: 'Which unit to answer for; the SDK takes it from the handle.',
    },
    derivedParams: {
      daoId: 'Defaults to the acting seat’s unit.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      const gov = await org.governance.read()
      return ok({
        unitDaoId: org.seat?.daoId ?? null,
        enabledTypes: [...gov.enabledTypes],
        configs: plain(gov.configs),
        typeBindings: plain(gov.typeBindings),
        slots: plain(gov.slots ?? null),
        state: plain(gov.state ?? null),
        freeze: plain(gov.freeze ?? null),
      })
    },
  },
  {
    name: 'org_treasury_balances',
    title: 'A unit’s treasury coin balances',
    description:
      'Every coin the unit’s treasury holds, enumerated from the vault’s own coin-type set. Cycle 7 drops a coin from that set when it is drained, so an absent coin means a zero balance. Coins TRANSFERRED to the treasury’s address are not counted until claimed (prepare_org_treasury_claim).',
    kind: 'read',
    sdkPath: 'org.treasury.balances',
    inputShape: {
      ...actingShape,
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Which unit to answer for; the SDK takes it from the handle.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(await org.treasury.balances(args.treasuryVaultId))
    },
  },
  {
    name: 'org_treasury_balance',
    title: 'One coin’s treasury balance',
    description:
      'A single coin balance in the unit’s treasury (defaults to CRED), or 0.',
    kind: 'read',
    sdkPath: 'org.treasury.balance',
    inputShape: {
      ...actingShape,
      coinType: z.string().optional().describe('Defaults to CRED.'),
      treasuryVaultId: objectId.optional(),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Which unit to answer for; the SDK takes it from the handle.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok({
        coinType: args.coinType ?? 'CRED',
        amount: await org.treasury.balance(args.coinType, args.treasuryVaultId),
      })
    },
  },
  {
    name: 'org_vault_resolve',
    title: 'Find this organization’s shared storage at a hub',
    description:
      'The vault THIS organization registered at a storage unit, or null. Vaults are keyed by (storage unit, organization), so there is no such thing as "the vault at this hub" — resolving by hub alone would return a stranger’s. Defaults the registrant to the acting seat, then walks the rest of the tree.',
    kind: 'read',
    sdkPath: 'org.vault.resolve',
    inputShape: {
      ...actingShape,
      storageUnitId: objectId,
      registrantOrgId: objectId
        .optional()
        .describe('Pin the registering unit instead of searching the tree.'),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Which unit to search from; the SDK takes it from the handle.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok({
        vaultId: await org.vault.resolve({
          storageUnitId: args.storageUnitId,
          registrantOrgId: args.registrantOrgId,
        }),
      })
    },
  },
  {
    name: 'org_vault_info',
    title: 'Read a shared-storage vault',
    description:
      'A vault’s live identity, access grants, and non-empty asset count, read on-chain. Prefer org_vaults_at_hub for listing; use this when the answer must be head-current — deciding whether a grant has landed, for instance, where the indexer’s 30-second cache is exactly long enough to mislead.',
    kind: 'read',
    sdkPath: 'org.vault.info',
    inputShape: { ...actingShape, vaultId: objectId },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Unused for this read; accepted so the acting shape is uniform.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(await org.vault.info(args.vaultId))
    },
  },
  {
    name: 'org_vault_balance',
    title: 'One item’s balance in shared storage',
    description: 'A single asset’s balance held in a vault, or 0.',
    kind: 'read',
    sdkPath: 'org.vault.balance',
    inputShape: {
      ...actingShape,
      vaultId: objectId,
      assetId: u64.describe('Item asset id as a decimal string.'),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Unused for this read; accepted so the acting shape is uniform.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok({
        assetId: args.assetId,
        amount: await org.vault.balance(args.vaultId, big(args.assetId)),
      })
    },
  },
  {
    name: 'org_vaults_at_hub_for_org',
    title: 'Shared storage at a hub (via the handle)',
    description:
      'Same listing as org_vaults_at_hub, reached through an organization handle. Prefer org_vaults_at_hub — it needs no acting address.',
    kind: 'read',
    sdkPath: 'org.vault.atHub',
    inputShape: { ...actingShape, hubId: objectId },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Unused for this read; accepted so the acting shape is uniform.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(await org.vault.atHub(args.hubId))
    },
  },
  // ─── cycle-7 unit-scoped reads ─────────────────────────────────────────────

  {
    name: 'org_proposal',
    title: 'One proposal’s live on-chain state',
    description:
      'A proposal’s LIVE state read from the chain: snapshot weight (the quorum denominator), votes cast by voter, yes/no weight, decoded payload, the config snapshotted at submission, status (active / passed), and its deadlines — votingDeadlineMs, executableFromMs, and when a passed proposal’s execution window closes. null when the object no longer exists: cycle 7 deletes a proposal on execution and on expiry cleanup, and org_proposals then has the outcome.',
    kind: 'read',
    sdkPath: 'org.governance.proposal',
    inputShape: { ...actingShape, proposalId: objectId },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Unused for this read; accepted so the acting shape is uniform.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(plain(await org.governance.proposal(args.proposalId)))
    },
  },
  {
    name: 'org_expired_proposals',
    title: 'Proposals ready for deletion',
    description:
      'The organization’s proposals that prepare_org_delete_expired_proposals would accept RIGHT NOW: every indexed pending/passed proposal, hydrated from the chain and kept if its voting window (active) or execution window (passed) has closed. One chain read per open proposal.',
    kind: 'read',
    sdkPath: 'org.governance.expired',
    inputShape: { ...actingShape },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'Unused for this read; accepted so the acting shape is uniform.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(plain(await org.governance.expired()))
    },
  },
  {
    name: 'org_freeze',
    title: 'A unit’s emergency-freeze state',
    description:
      'Which payload Move types are frozen on a unit and until when (epoch ms), which types are exempt from freezing, and the maximum freeze duration. A frozen type cannot execute by any path until it lapses or is lifted.',
    kind: 'read',
    sdkPath: 'org.freeze.read',
    inputShape: {
      ...actingShape,
      unitId: objectId
        .optional()
        .describe('Unit to read; defaults to the acting seat.'),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'The default unit when unitId is omitted.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(plain(await org.freeze.read(args.unitId)))
    },
  },
  {
    name: 'org_entries',
    title: 'A unit’s encrypted entries',
    description:
      'Every encrypted entry a unit’s board has published: where its ciphertext lives, a description, who created it, the epoch it was encrypted under, and stale=true when the unit’s epoch has since rotated (re-encrypt and prepare_org_entry_update). METADATA ONLY — decrypting needs a wallet-signed Seal session key, which lives in @trinaryex/keyspace and which this server cannot produce.',
    kind: 'read',
    sdkPath: 'org.entries.list',
    inputShape: {
      ...actingShape,
      unitId: objectId
        .optional()
        .describe('Unit to read; defaults to the acting seat.'),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'The default unit when unitId is omitted.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(plain(await org.entries.list(args.unitId)))
    },
  },
  {
    name: 'org_capabilities',
    title: 'What a unit’s capability vault holds',
    description:
      'A unit’s capability vault by Move type: SubOUControl caps over its children, TreasuryCap<T>s of adopted currencies, ExternalExecutionCap<P>s (bypass), UpgradeCaps, a stored FreezeAdminCap, trading custody caps. The cap ids here are what the unit, currency, upgrade and bypass prepare tools take.',
    kind: 'read',
    sdkPath: 'org.capabilities.list',
    inputShape: {
      ...actingShape,
      unitId: objectId
        .optional()
        .describe('Unit to read; defaults to the acting seat.'),
    },
    syntheticParams: {
      orgId: 'Names the organization whose handle is opened.',
      address:
        'The acting address; per-request because this server is keyless.',
      seat: 'The default unit when unitId is omitted.',
    },
    handler: async (ctx, args) => {
      const org = await handle(ctx, args)
      return ok(plain(await org.capabilities.list(args.unitId)))
    },
  },
]
