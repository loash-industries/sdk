import { z } from 'zod'
import { ok } from '../result.js'
import { objectId, suiAddress, u64 } from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Hauling agreements: on-chain jobs to move cargo between hubs for an escrowed
 * reward. A lister posts cargo (at a source hub), what they want delivered (to
 * a destination hub), a reward and a collateral; a hauler accepts, locks the
 * collateral and has a fixed time to deliver, or defaults and forfeits it.
 *
 * Keyless reads through the caller's API key, identity always explicit: the
 * player-scoped tools take `address`, because this server has no configured
 * player to default to.
 */

const STATUSES = [
  'open',
  'lapsed',
  'accepted',
  'overdue',
  'delivered',
  'defaulted',
  'forfeited',
  'cancelled',
  'closed_lapsed',
] as const

const ROLES = [
  'lister',
  'cap_holder',
  'beneficiary',
  'hauler',
  'claimed_via_org',
] as const

const statusFilter = z
  .union([z.enum(STATUSES), z.array(z.enum(STATUSES)).min(1)])
  .optional()
  .describe(
    'One status or several. lapsed (open past its accept deadline) and overdue (accepted past its delivery deadline) are judged at evaluatedAt.',
  )

const minCheckpoint = {
  minCheckpoint: u64
    .optional()
    .describe(
      'Read-your-writes: only serve data that includes this indexer checkpoint, e.g. the checkpoint of a transaction you just ran. If the indexer is behind, the gateway waits briefly and then answers with older data.',
    ),
}

const paging = {
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('1–100, default 50.'),
  cursor: z.string().optional().describe('nextCursor from the previous page.'),
  ...minCheckpoint,
}

const address = suiAddress.describe('The player wallet address.')

const AMOUNTS =
  'Amounts (reward, collateral, fees, quantities) are raw base units as decimal strings; scale by the currency decimals.'

export const haulingTools: ToolDef[] = [
  {
    name: 'hauling_agreements',
    title: 'Search hauling agreements',
    description:
      'The hauling job board: open agreements by default, newest first. Filter by status, reward currency and minimum, source or destination hub, cargo or wanted items, lister, hauler, organization, and whether a claim gate applies. Pass claimableBy to get each row’s eligibility for that address (use hauling_claimable for only the ones it can accept). Page with cursor. ' +
      AMOUNTS +
      ' Costs 50 CU.',
    kind: 'read',
    sdkPath: 'hauling.agreements',
    inputShape: {
      ...paging,
      status: statusFilter,
      currency: z
        .string()
        .optional()
        .describe('Reward coin type, e.g. 0x…::cred::CRED.'),
      minReward: u64.optional().describe('Minimum reward, raw base units.'),
      sourceHubId: objectId.optional().describe('Hub the cargo is at.'),
      destinationHubId: objectId
        .optional()
        .describe('Hub the wanted items must reach.'),
      cargoCollectionId: objectId.optional(),
      wantCollectionId: objectId.optional(),
      cargoAssetId: z
        .string()
        .optional()
        .describe('Item asset id in the cargo.'),
      wantAssetId: z
        .string()
        .optional()
        .describe('Item asset id among the wanted items.'),
      lister: suiAddress.optional(),
      hauler: suiAddress.optional(),
      orgId: objectId
        .optional()
        .describe('Agreements gated to or posted for this organization.'),
      gated: z
        .boolean()
        .optional()
        .describe(
          'Only agreements with (true) or without (false) a claim gate.',
        ),
      claimableBy: suiAddress
        .optional()
        .describe('Report eligibility for this address on every row.'),
      acceptDeadlineBefore: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Unix ms: only agreements whose accept deadline is earlier.'),
      sort: z
        .enum([
          'posted_desc',
          'reward_desc',
          'accept_deadline_asc',
          'delivery_deadline_asc',
        ])
        .optional(),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.agreements(args)),
  },
  {
    name: 'hauling_agreement',
    title: 'Get a hauling agreement',
    description:
      'One hauling agreement in full: parties, cargo and wanted items with their hubs, reward, collateral and deadlines, accept requirements (claim gates listing players, machine keys and organizations), the lister cap, proceeds, fees, claims and a timeline of events. Pass viewer to add that address’s roles and claim plan (how it would satisfy each gate). Fails with AgreementNotFound for an unknown id. ' +
      AMOUNTS +
      ' Costs 30 CU.',
    kind: 'read',
    sdkPath: 'hauling.agreement',
    inputShape: {
      agreementId: objectId.describe('The agreement object id.'),
      viewer: suiAddress
        .optional()
        .describe('Address to report roles and a claim plan for.'),
      ...minCheckpoint,
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.agreement(args)),
  },
  {
    name: 'hauling_config',
    title: 'Get the hauling protocol config',
    description:
      'What posting a hauling agreement costs and accepts: the approved reward currencies (with symbol and decimals), the flat posting fee, the delivery fee in basis points, the treasury, and recent admin changes. Fails with IndexerError (503 upstream) until the indexer has seen the first config. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'hauling.config',
    inputShape: minCheckpoint,
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.config(args)),
  },
  {
    name: 'hauling_stats',
    title: 'Get hauling protocol stats',
    description:
      'Protocol-wide hauling stats: agreements by status, volume per currency (rewards escrowed and paid, delivery fees, collateral forfeited), posting fees per fee coin, and the ten busiest hub-to-hub lanes. Cached for 30 seconds upstream. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'hauling.stats',
    inputShape: minCheckpoint,
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.stats(args)),
  },
  {
    name: 'hauling_org_agreements',
    title: 'List an organization’s hauling agreements',
    description:
      'Hauling agreements related to an organization, newest first: gated_to (default) lists those its board members may claim, claimed_via those accepted through it, posted_for those posted on its behalf. Fails with OrgNotFound for an unknown organization. ' +
      AMOUNTS +
      ' Costs 30 CU.',
    kind: 'read',
    sdkPath: 'hauling.orgAgreements',
    inputShape: {
      orgId: objectId.describe('Organization (OU) object id.'),
      relation: z.enum(['gated_to', 'claimed_via', 'posted_for']).optional(),
      status: statusFilter,
      ...paging,
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.orgAgreements(args)),
  },
  {
    name: 'hauling_player_agreements',
    title: 'List a player’s hauling agreements',
    description:
      'Hauling agreements an address plays a part in, newest first — as lister, cap_holder, beneficiary, hauler, or claimed_via_org (accepted through an organization whose board it sits on). Each row’s viewerRoles says which. Filter with role and status. ' +
      AMOUNTS +
      ' Costs 50 CU.',
    kind: 'read',
    sdkPath: 'hauling.playerAgreements',
    inputShape: {
      address,
      role: z
        .union([z.enum(ROLES), z.array(z.enum(ROLES)).min(1)])
        .optional()
        .describe('One role or several.'),
      status: statusFilter,
      ...paging,
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.playerAgreements(args)),
  },
  {
    name: 'hauling_actions',
    title: 'Get a player’s hauling to-do list',
    description:
      'What an address should do next across its hauling agreements: collect proceeds its lister cap received, delete a spent cap, cancel a listing nobody accepted in time, deliver a job before its deadline (soonest first), or default an overdue job it is owed. Each item names the Move call (moveCall) and its type argument. Costs 30 CU.',
    kind: 'read',
    sdkPath: 'hauling.actions',
    inputShape: { address, ...minCheckpoint },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.actions(args)),
  },
  {
    name: 'hauling_claimable',
    title: 'List hauling agreements a player can accept',
    description:
      'Open agreements, before their accept deadline, that an address can accept: no claim gate, or every gate lists the address (as a player or machine key) or an organization whose board it sits on. Each comes with its claim plan — per requirement, whether to satisfy it directly or through an organization. includeUnknown also lists agreements with rules the indexer cannot evaluate. ' +
      AMOUNTS +
      ' Costs 50 CU.',
    kind: 'read',
    sdkPath: 'hauling.claimable',
    inputShape: {
      address,
      includeUnknown: z.boolean().optional(),
      ...paging,
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.claimable(args)),
  },
  {
    name: 'hauling_reputation',
    title: 'Get a player’s hauling record',
    description:
      'An address’s hauling record. As hauler: jobs accepted, in progress, overdue, delivered, defaulted and forfeited, the completion rate (null before any job finishes), and net rewards and collateral lost per currency. As lister: agreements posted and how they went. Counts are by wallet address. Costs 30 CU.',
    kind: 'read',
    sdkPath: 'hauling.reputation',
    inputShape: { address, ...minCheckpoint },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().hauling.reputation(args)),
  },
]
