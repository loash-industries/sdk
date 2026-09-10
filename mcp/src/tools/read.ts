import { z } from 'zod'
import { ok } from '../result.js'
import {
  cursorPagingShape,
  historyPagingShape,
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
