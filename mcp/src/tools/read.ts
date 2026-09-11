import { z } from 'zod'
import { ok } from '../result.js'
import {
  cursorPagingShape,
  historyPagingShape,
  locationPagingShape,
  objectId,
  searchPagingShape,
  suiAddress,
} from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Read tools. Every one of these is a thin delegation to the SDK's read
 * surface, authenticated by the caller's own API key. No key material, no
 * writes, nothing cached across tenants.
 */
export const readTools: ToolDef[] = [
  {
    name: 'market_discover',
    title: 'Discover markets',
    description:
      'List active orders across trade hubs, optionally filtered. Use this to find where an item is trading, or to scan several hubs in one call.',
    kind: 'read',
    sdkPath: 'market.discover',
    inputShape: {
      assetId: z.string().optional(),
      storageUnitIds: z
        .array(objectId)
        .min(1)
        .max(20)
        .optional()
        .describe('Restrict to these trade hubs. Omit to scan every hub.'),
      side: z.enum(['buy', 'sell', 'both']).optional(),
      publicOnly: z.boolean().optional(),
      ...cursorPagingShape,
    },
    handler: async (ctx, args) => ok(await ctx.readClient().discover(args)),
  },
  {
    name: 'market_search_items',
    title: 'Search items',
    description:
      'Resolve an EVE Frontier item name to its asset id, with fuzzy matching.',
    kind: 'read',
    sdkPath: 'market.searchItems',
    inputShape: {
      query: z.string().min(1).describe('Item name or partial name.'),
      ...searchPagingShape,
    },
    handler: async (ctx, args) => {
      const { query, ...rest } = args
      return ok(await ctx.readClient().searchItems(query, rest))
    },
  },
  {
    name: 'market_hub',
    title: 'Get trade hub',
    description:
      'Detail for one trade hub: vault configuration, collection, and location when public.',
    kind: 'read',
    sdkPath: 'market.hub',
    inputShape: { hubId: objectId },
    handler: async (ctx, args) => ok(await ctx.readClient().hub(args.hubId)),
  },
  {
    name: 'market_items_at_hub',
    title: 'List items at a hub',
    description: 'Every item with a market at a given trade hub.',
    kind: 'read',
    sdkPath: 'market.itemsAtHub',
    inputShape: { hubId: objectId },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().itemsAtHub(args.hubId)),
  },
  {
    name: 'market_orderbook',
    title: 'Read the order book',
    description:
      'Live resting bids and asks for an item at a hub. Use before sizing a market order.',
    kind: 'read',
    sdkPath: 'market.orderbook',
    inputShape: {
      storageUnitId: objectId,
      assetId: z.string(),
    },
    handler: async (ctx, args) => ok(await ctx.readClient().orderbook(args)),
  },
  {
    name: 'market_pool_metadata',
    title: 'Get pool metadata',
    description:
      'Pool parameters: lot size, tick size, minimum size, and the fee rate used to compute worst-case costs.',
    kind: 'read',
    sdkPath: 'market.poolMetadata',
    inputShape: { poolId: objectId },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().poolMetadata(args.poolId)),
  },
  {
    name: 'market_hub_locations',
    title: 'List hub locations',
    description:
      'Every indexed trade hub and where it sits, cursor-paged. This is the entry point when you have no hub id yet — filter by solar system, tenant, or hasVault to see only hubs where trading is actually initialised.',
    kind: 'read',
    sdkPath: 'market.hubLocations',
    inputShape: {
      solarSystemId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Numeric solar system id, e.g. 30000142.'),
      tenant: z.string().optional().describe('Tenant (shard) to restrict to.'),
      hasVault: z
        .boolean()
        .optional()
        .describe('Only hubs that have trading initialised (a vault exists).'),
      ...locationPagingShape,
    },
    handler: async (ctx, args) => ok(await ctx.readClient().hubLocations(args)),
  },
  {
    name: 'market_item_locations',
    title: 'Find where an item is sold',
    description:
      'Trade hub locations currently offering an item for sale, cursor-paged. Answers "where can I buy this" before market_orderbook prices it at one hub.',
    kind: 'read',
    sdkPath: 'market.itemLocations',
    inputShape: {
      assetId: z.string().describe('EVE Frontier item asset id, e.g. "70810".'),
      ...locationPagingShape,
    },
    handler: async (ctx, args) => {
      const { assetId, ...rest } = args
      return ok(await ctx.readClient().itemLocations(assetId, rest))
    },
  },
  {
    name: 'market_nearby_hubs',
    title: 'Find hubs near a hub',
    description:
      'Trade hubs within a light-year radius of another hub, optionally only those with open orders for one item. The origin hub must publish a location — use market_nearby_hubs_by_system when it does not.',
    kind: 'read',
    sdkPath: 'market.nearbyHubs',
    inputShape: {
      hubId: objectId,
      rangeLy: z
        .number()
        .positive()
        .max(3500)
        .optional()
        .describe('Search radius in light years (default and max 3500).'),
      assetId: z
        .string()
        .optional()
        .describe('Only hubs with open orders for this item type.'),
    },
    handler: async (ctx, args) => ok(await ctx.readClient().nearbyHubs(args)),
  },
  {
    name: 'market_nearby_hubs_by_system',
    title: 'Find hubs near a solar system',
    description:
      'The same proximity search as market_nearby_hubs, centred on a solar system id or name instead of a hub. Use it when the origin hub is private and publishes no location.',
    kind: 'read',
    sdkPath: 'market.nearbyHubsBySystem',
    inputShape: {
      solarSystem: z
        .string()
        .min(1)
        .describe('Solar system id or name to search from, e.g. "Nod".'),
      rangeLy: z
        .number()
        .positive()
        .max(3500)
        .optional()
        .describe('Search radius in light years (default and max 3500).'),
      assetId: z
        .string()
        .optional()
        .describe('Only hubs with open orders for this item type.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().nearbyHubsBySystem(args)),
  },
  {
    name: 'market_hubs_enriched',
    title: 'Batch hub detail',
    description:
      'Location, market count, and last storage activity for up to 200 hubs in one call — the batch form of market_hub for scanning a watchlist. Does not resolve solar system names; pass the ids to market_solar_system_names for those.',
    kind: 'read',
    sdkPath: 'market.hubsEnriched',
    inputShape: {
      hubIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('Trade hub object ids (max 200).'),
    },
    handler: async (ctx, args) => ok(await ctx.readClient().hubsEnriched(args)),
  },
  {
    name: 'market_assembly_owners',
    title: 'Resolve assembly owners',
    description:
      'Owner wallet address for up to 200 assembly (in-game structure) object ids, resolved on-chain.',
    kind: 'read',
    sdkPath: 'market.assemblyOwners',
    inputShape: {
      assemblyIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('Assembly Sui object ids (max 200).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().assemblyOwners(args)),
  },
  {
    name: 'market_assemblies_enriched',
    title: 'Resolve assembly owners and names',
    description:
      'market_assembly_owners plus the owner character and the assembly name, for up to 200 assembly object ids.',
    kind: 'read',
    sdkPath: 'market.assembliesEnriched',
    inputShape: {
      assemblyIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('Assembly Sui object ids (max 200).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().assembliesEnriched(args)),
  },
  {
    name: 'market_solar_system_names',
    title: 'Name solar systems',
    description:
      'Display names for up to 200 numeric solar system ids. Pair with market_hubs_enriched, which returns ids without names.',
    kind: 'read',
    sdkPath: 'market.solarSystemNames',
    inputShape: {
      solarSystemIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('Numeric solar system ids (max 200).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().solarSystemNames(args)),
  },
  {
    name: 'account_resolve',
    title: 'Resolve a trading account',
    description:
      'Return the BalanceManager object id for an address, or null when the address has no trading account yet. Pair with prepare_create_account.',
    kind: 'read',
    sdkPath: 'account.get',
    inputShape: { address: suiAddress },
    handler: async (ctx, args) => {
      const id = await ctx
        .writeClient(args.address)
        .resolveBalanceManagerId(args.address)
      return ok({ address: args.address, balanceManagerId: id, exists: !!id })
    },
  },
  {
    name: 'account_balances_at_hub',
    title: 'Check balances at a hub',
    description:
      'Item and currency balances for a trading account at one hub, across wallet, trading account, and hangar.',
    kind: 'read',
    sdkPath: 'balances.atHub',
    inputShape: {
      balanceManagerId: objectId,
      storageUnitId: objectId,
    },
    handler: async (ctx, args) =>
      ok(
        await ctx
          .readClient()
          .balancesAtHub(args.balanceManagerId, args.storageUnitId),
      ),
  },
  {
    name: 'account_sweepable',
    title: 'List claimable proceeds',
    description:
      'Unclaimed proceeds and settled balances that can be claimed or withdrawn.',
    kind: 'read',
    sdkPath: 'account.sweepable',
    inputShape: { balanceManagerId: objectId },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().sweepable(args.balanceManagerId)),
  },
  {
    name: 'account_owners',
    title: 'Resolve trading account owners',
    description:
      'Who owns these trading accounts, for up to 200 BalanceManager ids — how a counterparty id from the order book gets a name. `owner` is tagged: `player:<wallet>` for a character-owned account, `ou:<org_id>` for an organization-owned one.',
    kind: 'read',
    sdkPath: 'account.owners',
    inputShape: {
      balanceManagerIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('BalanceManager object ids (max 200).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().accountOwners(args)),
  },
  {
    name: 'orders_open',
    title: 'List open orders',
    description: 'Resting orders for a trading account.',
    kind: 'read',
    sdkPath: 'orders.openOrders',
    inputShape: { balanceManagerId: objectId, ...historyPagingShape },
    handler: async (ctx, args) => {
      const { balanceManagerId, ...rest } = args
      return ok(await ctx.readClient().openOrders(balanceManagerId, rest))
    },
  },
  {
    name: 'orders_fills',
    title: 'List fills',
    description: "This account's side of each match, most recent first.",
    kind: 'read',
    sdkPath: 'orders.fills',
    inputShape: { balanceManagerId: objectId, ...historyPagingShape },
    handler: async (ctx, args) => {
      const { balanceManagerId, ...rest } = args
      return ok(await ctx.readClient().fills(balanceManagerId, rest))
    },
  },
  {
    name: 'orders_trades',
    title: 'List trades',
    description: 'Completed trades for a trading account.',
    kind: 'read',
    sdkPath: 'orders.trades',
    inputShape: { balanceManagerId: objectId, ...historyPagingShape },
    handler: async (ctx, args) => {
      const { balanceManagerId, ...rest } = args
      return ok(await ctx.readClient().trades(balanceManagerId, rest))
    },
  },
]
