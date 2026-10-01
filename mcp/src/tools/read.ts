import { z } from 'zod'
import { ok } from '../result.js'
import {
  cursorPagingShape,
  decimalInt,
  historyPagingShape,
  locationPagingShape,
  objectId,
  searchPagingShape,
  suiAddress,
  u128,
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
      'The same proximity search as market_nearby_hubs, centred on a solar system id or name instead of a hub. Use it when the origin hub is private and publishes no location. Prefer the numeric id: names are not yet available for every system, and an unresolvable name fails with SolarSystemNotFound.',
    kind: 'read',
    sdkPath: 'market.nearbyHubsBySystem',
    inputShape: {
      solarSystem: z
        .string()
        .min(1)
        .describe(
          'Solar system id (preferred) or name to search from, e.g. "30000142".',
        ),
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
    name: 'market_recent_trades',
    title: 'Read the public tape',
    description:
      'The latest trades across every item market, newest first — the public tape, not one account’s history (that is orders_trades). At most 50 per page: page back by passing nextCursor as `before`, poll for new trades with `after`. Unlike every other trade read, price, quantity and feeAmount are HUMAN-READABLE decimal strings already scaled by quoteCurrencyDecimals, and feeRateBps is that fill’s own effective taker rate. solarSystemName is null until a player reports it — key on solarSystemId. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'market.recentTrades',
    inputShape: {
      assetId: z
        .string()
        .optional()
        .describe('Only trades of this item type, e.g. "77800".'),
      publicOnly: z
        .boolean()
        .optional()
        .describe('Only trades at hubs that publish their location.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Trades per page (max 50 — the gateway caps it there).'),
      before: historyPagingShape.before,
      after: historyPagingShape.after,
    },
    handler: async (ctx, args) => ok(await ctx.readClient().recentTrades(args)),
  },
  {
    name: 'market_display_prices',
    title: 'Price many items',
    description:
      'Display prices for up to 100 items in one call. itemIds alone gives one item-wide price per item; add storageUnitIds for the per-hub price — one id applies to every item, otherwise give exactly one per item, paired by position. This is the PLAIN market price with no trading fee: use it to show or rank value, and orders_fees or market_orderbook to cost an actual trade. `tier` says where each price came from (traded → item → book → estimated → unknown); price is a human-readable decimal and priceRaw the raw quote integer, both strings. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'market.displayPrices',
    inputShape: {
      itemIds: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe('Item asset ids to price (max 100), e.g. ["77800"].'),
      storageUnitIds: z
        .array(objectId)
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Trade hub (or vault collection) ids: one for every item, or one per item in itemIds order.',
        ),
      fallback: z
        .boolean()
        .optional()
        .describe(
          'Per-hub mode only: false disables falling back to the item-wide price when the hub has no pool for an item (default true).',
        ),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().displayPrices(args)),
  },
  {
    name: 'market_display_price',
    title: 'Price one item',
    description:
      'The single-item form of market_display_prices: the plain market price (no trading fee) for one item, item-wide or at one hub. Cheaper than the batch for one lookup. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'market.displayPrice',
    inputShape: {
      itemId: z.string().min(1).describe('Item asset id, e.g. "77800".'),
      storageUnitId: objectId
        .optional()
        .describe(
          'Price at this trade hub (or vault collection); omit for the item-wide price.',
        ),
      fallback: z
        .boolean()
        .optional()
        .describe(
          'With storageUnitId: false disables falling back to the item-wide price (default true).',
        ),
    },
    handler: async (ctx, args) => {
      const { itemId, ...opts } = args
      return ok(await ctx.readClient().displayPrice(itemId, opts))
    },
  },
  {
    name: 'market_hub_economics',
    title: 'Compare hub liquidity',
    description:
      'Fee reserve (raw quote units) and open-order depth for up to 200 hubs, as decimal strings, plus how many distinct items have open orders. Use it to rank hubs from market_hub_locations or market_nearby_hubs by how much is actually trading there. Hubs that no longer exist are omitted. Cached upstream for 30 s. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'market.hubEconomics',
    inputShape: {
      hubIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('Trade hub object ids (max 200).'),
    },
    handler: async (ctx, args) => ok(await ctx.readClient().hubEconomics(args)),
  },
  {
    name: 'market_top_pools_by_fees',
    title: 'Rank pools by unclaimed fees',
    description:
      'Item pools ranked by unclaimed fee balance, largest first; only pools with a positive balance appear. Amounts are raw quote units as decimal strings, and quoteType is the coin type as indexed — without its 0x prefix, so normalise it before comparing. Pair with prepare_claim_operator_share to claim the operator share. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'market.topPoolsByFees',
    inputShape: {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Pools to return (default 20, max 100).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().topPoolsByFees(args)),
  },
  {
    name: 'market_stats',
    title: 'Get platform statistics',
    description:
      'Platform-wide aggregates: trades and active traders by time window, volume per quote currency, top items, organization, shared-storage and pilot totals, and 30-day daily series. A dashboard read — cached upstream for up to 60 s, so do not poll it faster. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'market.stats',
    inputShape: {},
    handler: async (ctx) => ok(await ctx.readClient().stats()),
  },
  {
    name: 'spatial_system',
    title: 'Get a solar system',
    description:
      'Coordinates, constellation and region for one solar system, by name or numeric id — "EHK-KH7" and "30000142" both resolve. Coordinates are metres as decimal strings; they exceed 2^53 and would lose precision as JSON numbers.',
    kind: 'read',
    sdkPath: 'spatial.system',
    inputShape: {
      solarSystem: z
        .string()
        .min(1)
        .describe('Solar system name (case-insensitive) or numeric id.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().spatialSystem(args.solarSystem)),
  },
  {
    name: 'spatial_systems',
    title: 'Look up many solar systems',
    description:
      'Resolve up to 100 solar systems in one call. Pass solarSystemIds OR solarSystemNames, never both. Identifiers that match nothing are omitted rather than returned as nulls, so compare `count` against how many you asked for to spot misses.',
    kind: 'read',
    sdkPath: 'spatial.systems',
    inputShape: {
      solarSystemIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(100)
        .optional()
        .describe('Numeric solar system ids (max 100). Omit if using names.'),
      solarSystemNames: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .optional()
        .describe('Solar system names (max 100). Omit if using ids.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().spatialSystems(args)),
  },
  {
    name: 'spatial_nearby_systems',
    title: 'Find systems near a system',
    description:
      'Solar systems within a light-year radius of another system, nearest first. The origin system is excluded from the results. Use this to answer "what is in jump range of here".',
    kind: 'read',
    sdkPath: 'spatial.nearbySystems',
    inputShape: {
      solarSystem: z
        .string()
        .min(1)
        .describe('Origin system name or numeric id.'),
      radiusLy: z
        .number()
        .positive()
        .max(10_000)
        .describe('Search radius in light years (max 10,000).'),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe('Systems to return, nearest first (default 100, max 1000).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().spatialNearbySystems(args)),
  },
  {
    name: 'spatial_systems_near_coordinates',
    title: 'Find systems near a point',
    description:
      'The same radius search around an arbitrary point in space, for an origin that is not itself a solar system — a ship or structure position read from the chain. Unlike spatial_nearby_systems this can include the system containing the point. x, y and z are metres as decimal strings.',
    kind: 'read',
    sdkPath: 'spatial.systemsNearCoordinates',
    inputShape: {
      x: decimalInt.describe('X coordinate of the origin, in metres.'),
      y: decimalInt.describe('Y coordinate of the origin, in metres.'),
      z: decimalInt.describe('Z coordinate of the origin, in metres.'),
      radiusLy: z
        .number()
        .positive()
        .max(10_000)
        .describe('Search radius in light years (max 10,000).'),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe('Systems to return, nearest first (default 100, max 1000).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().spatialSystemsNearCoordinates(args)),
  },
  {
    name: 'spatial_autocomplete_systems',
    title: 'Autocomplete system names',
    description:
      'Solar systems whose name starts with the given prefix, alphabetically. Returns identifiers only and is served from an in-memory index, so prefer it over spatial_system when resolving a partial name the user typed.',
    kind: 'read',
    sdkPath: 'spatial.autocompleteSystems',
    inputShape: {
      query: z.string().min(1).describe('Name prefix, case-insensitive.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Suggestions to return (default 10, max 50).'),
    },
    handler: async (ctx, args) => {
      const { query, ...rest } = args
      return ok(await ctx.readClient().spatialAutocompleteSystems(query, rest))
    },
  },
  {
    name: 'spatial_stats',
    title: 'Get star-map coverage',
    description:
      'How many solar systems the coordinate index holds, and whether it is loaded. Use it to confirm which dataset results came from before caching them.',
    kind: 'read',
    sdkPath: 'spatial.stats',
    inputShape: {},
    handler: async (ctx) => ok(await ctx.readClient().spatialStats()),
  },
  {
    name: 'account_resolve',
    title: 'Resolve a trading account',
    description:
      'Return the TradingAccount object id for an address, or null when the address has no trading account yet. Pair with prepare_create_account.',
    kind: 'read',
    sdkPath: 'account.get',
    inputShape: { address: suiAddress },
    handler: async (ctx, args) => {
      const id = await ctx
        .writeClient(args.address)
        .resolveTradingAccountId(args.address)
      return ok({ address: args.address, tradingAccountId: id, exists: !!id })
    },
  },
  {
    name: 'account_balances_at_hub',
    title: 'Check balances at a hub',
    description:
      'Item balances at one hub, in up to four sections: `marketplace` (deposited in a trading account), `warehouse` (receipts in a wallet), `hangar` (an owner_cap_id’s hangar) and `orgVaults` (organization receipt vaults). Each section is filled only when its selector is given — name at least one. Items only: CRED lives on the fullnode, so use account_currency_balances for it. Amounts are base units as decimal strings. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'balances.atHub',
    inputShape: {
      storageUnitId: objectId.describe(
        'Trade hub / storage unit object id; scopes the whole read.',
      ),
      tradingAccountId: objectId
        .optional()
        .describe(
          'Fills `marketplace`: items deposited in this trading account (from account_resolve).',
        ),
      address: suiAddress
        .optional()
        .describe(
          'Fills `warehouse`: this wallet’s item receipts held at the hub.',
        ),
      inventoryKey: objectId
        .optional()
        .describe(
          'Fills `hangar`: the hub or character owner_cap_id selecting the hangar.',
        ),
      vaultIds: z
        .array(objectId)
        .min(1)
        .optional()
        .describe(
          'Fills `orgVaults`: organization receipt vault ids, keyed by id in the answer.',
        ),
    },
    handler: async (ctx, args) => {
      const { storageUnitId, tradingAccountId, address, inventoryKey } = args
      const vaultIds: string[] | undefined = args.vaultIds
      // Every section comes back empty unless its selector is given, so a call
      // naming none would spend 50 CU to learn nothing.
      if (!tradingAccountId && !address && !inventoryKey && !vaultIds) {
        throw new Error(
          'Name at least one section to read: tradingAccountId, address, inventoryKey or vaultIds.',
        )
      }
      return ok(
        await ctx.readClient().balancesAtHub({
          storageUnitId,
          ...(tradingAccountId ? { tradingAccountId } : {}),
          ...(address ? { address } : {}),
          ...(inventoryKey ? { inventoryKey } : {}),
          ...(vaultIds ? { vaultIds } : {}),
        }),
      )
    },
  },
  {
    name: 'account_currency_balances',
    title: 'Check CRED balances',
    description:
      'CRED held by an address: loose in the wallet, and deposited inside its trading account. Works for an address that has no trading account yet — that answers with the wallet total, a zero deposited balance, and a null tradingAccountId, which is the signal to call prepare_create_account. Read head-current from the fullnode, so it reflects transactions the indexer has not caught up with yet. Amounts are base units as decimal strings.',
    kind: 'read',
    sdkPath: 'balances.currency',
    inputShape: {
      address: suiAddress.describe('Sui address whose CRED to read.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.writeClient(args.address).balances.currency(args.address)),
  },
  {
    name: 'account_sweepable',
    title: 'List claimable proceeds',
    description:
      'Unclaimed proceeds and settled balances that can be claimed or withdrawn.',
    kind: 'read',
    sdkPath: 'account.sweepable',
    inputShape: { tradingAccountId: objectId },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().sweepable(args.tradingAccountId)),
  },
  {
    name: 'account_owners',
    title: 'Resolve trading account owners',
    description:
      'Who owns these trading accounts, for up to 200 TradingAccount ids — how a counterparty id from the order book gets a name. `owner` is tagged: `player:<wallet>` for a character-owned account, `ou:<org_id>` for an organization-owned one.',
    kind: 'read',
    sdkPath: 'account.owners',
    inputShape: {
      tradingAccountIds: z
        .array(objectId)
        .min(1)
        .max(200)
        .describe('TradingAccount object ids (max 200).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().accountOwners(args)),
  },
  {
    name: 'account_caps',
    title: 'List trading account capabilities',
    description:
      'Capabilities around an address, read head-current from the fullnode: the cap ids on its own trading account’s allow-list (what prepare_revoke_account_cap can revoke), and the Trade/Deposit/WithdrawCaps it holds for any account. tradingAccountId is null and allowListed empty when the address has no trading account. Pair with prepare_mint_account_cap.',
    kind: 'read',
    sdkPath: 'account.caps',
    inputShape: {
      address: suiAddress.describe('Sui address whose caps to read.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.writeClient(args.address).account.caps(args.address)),
  },
  {
    name: 'orders_fees',
    title: 'Read item-pool fees',
    description:
      'Live fee state of one item pool, from the on-chain FeePolicy: the active and staged fee ladders, entry taker/maker rates, cancel retention, and bidEscrowFeeRate — the rate a bid deposit must cover. With an address, also that account’s own tier, turnover and rates. Rates are 1e9-scaled (11000000 = 1.10%) as decimal strings. Identify the pool by poolId, or by storageUnitId + assetId. Use it to size quoteBudget for prepare_market_order, or to price a bid before prepare_limit_order.',
    kind: 'read',
    sdkPath: 'orders.fees',
    inputShape: {
      storageUnitId: objectId
        .optional()
        .describe('Trade hub / storage unit object id; pair with assetId.'),
      assetId: z
        .string()
        .optional()
        .describe('EVE Frontier item asset id; pair with storageUnitId.'),
      poolId: objectId
        .optional()
        .describe('Item pool id; use instead of storageUnitId + assetId.'),
      address: suiAddress
        .optional()
        .describe('Also resolve this address’s fee tier and rates.'),
    },
    handler: async (ctx, args) => {
      // The SDK branches on `'poolId' in params`, so an undefined key would
      // pick the wrong selector — build the params from what was given.
      const selector = args.poolId
        ? { poolId: args.poolId }
        : args.storageUnitId && args.assetId
          ? { storageUnitId: args.storageUnitId, assetId: args.assetId }
          : null
      if (!selector) {
        throw new Error(
          'Identify the pool by poolId, or by storageUnitId together with assetId.',
        )
      }
      return ok(
        await ctx.writeClient(args.address).orders.fees({
          ...selector,
          ...(args.address ? { address: args.address } : {}),
        }),
      )
    },
  },
  {
    name: 'orders_open',
    title: 'List open orders',
    description: 'Resting orders for a trading account.',
    kind: 'read',
    sdkPath: 'orders.openOrders',
    inputShape: { tradingAccountId: objectId, ...historyPagingShape },
    handler: async (ctx, args) => {
      const { tradingAccountId, ...rest } = args
      return ok(await ctx.readClient().openOrders(tradingAccountId, rest))
    },
  },
  {
    name: 'orders_fills',
    title: 'List fills',
    description: "This account's side of each match, most recent first.",
    kind: 'read',
    sdkPath: 'orders.fills',
    inputShape: { tradingAccountId: objectId, ...historyPagingShape },
    handler: async (ctx, args) => {
      const { tradingAccountId, ...rest } = args
      return ok(await ctx.readClient().fills(tradingAccountId, rest))
    },
  },
  {
    name: 'orders_trades',
    title: 'List trades',
    description: 'Completed trades for a trading account.',
    kind: 'read',
    sdkPath: 'orders.trades',
    inputShape: { tradingAccountId: objectId, ...historyPagingShape },
    handler: async (ctx, args) => {
      const { tradingAccountId, ...rest } = args
      return ok(await ctx.readClient().trades(tradingAccountId, rest))
    },
  },
  {
    name: 'orders_get',
    title: 'Look up an order',
    description:
      'One order on one pool, whatever became of it: status open, filled or cancelled, original/remaining/filled quantity, owner (trading account and character), hub, quote currency, and its fill history oldest first. This is how to follow up an order after prepare_limit_order — orders_open only lists orders still resting. Not limited to your own orders. Order ids are unique only per pool, so both are required. Prices and quantities are raw integers as decimal strings. Costs 30 CU.',
    kind: 'read',
    sdkPath: 'orders.get',
    inputShape: {
      poolId: objectId.describe(
        'Item pool id the order rests (or rested) on — from orders_open, orders_fills or market_orderbook.',
      ),
      orderId: u128.describe(
        'Order id (Move u128) as a decimal string — past 2^53, never a JSON number.',
      ),
    },
    handler: async (ctx, args) => ok(await ctx.readClient().order(args)),
  },
  {
    name: 'orders_fill',
    title: 'Look up a fill',
    description:
      'One fill by its eventDigest (as carried on orders_fills, orders_trades and orders_get), seen from neither side: both trading accounts, maker and taker fees, which side took, and when. Use it to identify a counterparty — pass the trading account ids to account_owners for a name. assetId and storageUnitId are null until the market’s metadata is indexed. Amounts are raw integers as decimal strings. Costs 30 CU.',
    kind: 'read',
    sdkPath: 'orders.fill',
    inputShape: {
      eventDigest: z
        .string()
        .min(1)
        .describe(
          'The fill’s event digest (transaction digest plus event index), exactly as a fill or trade read returned it.',
        ),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().fill(args.eventDigest)),
  },
]
