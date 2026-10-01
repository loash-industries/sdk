import { z } from 'zod'
import { ok } from '../result.js'
import { objectId, suiAddress } from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Reads about the game world rather than its markets: who the players are
 * (`characters_*`), how to get between systems (`routing_*`), and the static
 * item catalogue and crafting recipes (`world_*`).
 *
 * All of them are keyless indexer reads through the caller's own API key, with
 * identity always explicit — `characters_by_address` takes its address as an
 * argument, because this server has no configured player to default to.
 */

/**
 * A solar system NAME for the routing reads.
 *
 * Routing is name-only, and since cycle 7 a name is known only once a player
 * has reported it. A numeric id is never a name, so the upstream answer to one
 * is a guaranteed RouteNotFound at 100–300 CU; refusing it here turns that
 * charge into a schema error that says what to do instead.
 */
const systemName = z
  .string()
  .min(1)
  .regex(
    /\D/,
    'routing takes solar system NAMES, not numeric ids — resolve the id with spatial_system first; a system nobody has reported a name for cannot be routed to yet',
  )

const routeShipShape = {
  origin: systemName.describe(
    'Departure solar system NAME, case-insensitive, e.g. "U4T-SL7". Not an id.',
  ),
  destination: systemName.describe(
    'Arrival solar system NAME, case-insensitive. Not an id.',
  ),
  mass: z
    .number()
    .positive()
    .optional()
    .describe(
      'Ship mass in game units (default 1.0); heavier pushes fuel-optimal routes onto stargates.',
    ),
  gateWeight: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Preference for stargates over jump drives, 0–1 (default 0.5). Used by the balanced mode only.',
    ),
  maxJumpRangeLy: z
    .number()
    .positive()
    .optional()
    .describe(
      'The ship’s jump-drive range in light years (default 50). A larger range can connect a pair that otherwise fails.',
    ),
}

const NAMES_CAVEAT =
  'Origin and destination are solar system NAMES, never ids, and since cycle 7 names are player-reported: a system nobody has named yet fails with RouteNotFound even though it exists. Find names that resolve with spatial_autocomplete_systems or spatial_system. Waypoint solarSystemName is null for unreported systems — key on solarSystemId.'

export const worldTools: ToolDef[] = [
  // ─── Routing ──────────────────────────────────────────────────────────────
  {
    name: 'routing_route',
    title: 'Plan a route',
    description:
      'The optimal route between two solar systems over stargates and jump-drive hops, for one optimization mode: time (default, fewest jumps), fuel, or balanced (weighted by gateWeight). Returns the waypoints with each hop’s jump type and distance, and totals for jumps and light years. ' +
      NAMES_CAVEAT +
      ' RouteNotFound also means unreachable under these ship parameters — try a larger maxJumpRangeLy. Costs 100 CU; use routing_compare only when you need all three modes.',
    kind: 'read',
    sdkPath: 'routing.route',
    inputShape: {
      ...routeShipShape,
      optimization: z
        .enum(['time', 'fuel', 'balanced'])
        .optional()
        .describe(
          'time (default), fuel, or balanced. The answer names the mode differently (fastest, fuel_efficient, balanced).',
        ),
    },
    handler: async (ctx, args) => ok(await ctx.readClient().route(args)),
  },
  {
    name: 'routing_compare',
    title: 'Compare route modes',
    description:
      'The fuel-efficient, fastest and balanced routes between two systems in one consistent call — for showing the jumps-versus-fuel trade-off. ' +
      NAMES_CAVEAT +
      ' Priced as three route searches: costs 300 CU, so prefer routing_route when one mode will do.',
    kind: 'read',
    sdkPath: 'routing.compare',
    inputShape: routeShipShape,
    handler: async (ctx, args) =>
      ok(await ctx.readClient().compareRoutes(args)),
  },
  {
    name: 'routing_stats',
    title: 'Get routing coverage',
    description:
      'Size of the routing graph — connected systems, stargate and jump-drive edges — and the default jump range drive edges are built with. Pair with spatial_stats, whose knownSolarSystemNames says how much of the map can be routed to by name. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'routing.stats',
    inputShape: {},
    handler: async (ctx) => ok(await ctx.readClient().routingStats()),
  },

  // ─── Characters & tribes ──────────────────────────────────────────────────
  {
    name: 'characters_get',
    title: 'Get a character',
    description:
      'One player character by its object id: name, wallet address, tenant, tribe id and profile. With enrich, also the on-chain ownerCapId (the inventoryKey account_balances_at_hub takes for a hangar) and assemblyId. Fails with CharacterNotFound for an unknown id. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'characters.get',
    inputShape: {
      characterId: objectId.describe('Character Sui object id.'),
      enrich: z
        .boolean()
        .optional()
        .describe('Also resolve ownerCapId and assemblyId (default false).'),
    },
    handler: async (ctx, args) => {
      const { characterId, ...opts } = args
      return ok(await ctx.readClient().character(characterId, opts))
    },
  },
  {
    name: 'characters_by_address',
    title: 'Find a wallet’s characters',
    description:
      'Every character a wallet holds, newest first — a wallet can hold several (one per tenant, or a re-created character), and [] means none. The address is required: unlike the SDK, this server has no configured player to default to. For many wallets at once use characters_batch. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'characters.byAddress',
    inputShape: {
      address: suiAddress.describe('Wallet address to look up.'),
      enrich: z
        .boolean()
        .optional()
        .describe('Also resolve ownerCapId and assemblyId (default false).'),
    },
    handler: async (ctx, args) => {
      const { address, ...opts } = args
      return ok(await ctx.readClient().charactersByAddress(address, opts))
    },
  },
  {
    name: 'characters_by_name',
    title: 'Find characters by name',
    description:
      'Characters whose name matches EXACTLY (no fuzzy or prefix matching), newest first. Names are not unique, so this returns a list — disambiguate by tenant or address. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'characters.byName',
    inputShape: {
      name: z.string().min(1).describe('Exact character name.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().charactersByName(args.name)),
  },
  {
    name: 'characters_batch',
    title: 'Name many wallets',
    description:
      'Resolve up to 500 wallet addresses to their characters and tribe names in one call — how a list of owners from account_owners, org_seats or a fill gets names. Every address is echoed back in `address`; unresolved ones carry null fields rather than being dropped. Costs 50 CU.',
    kind: 'read',
    sdkPath: 'characters.batch',
    inputShape: {
      addresses: z
        .array(suiAddress)
        .min(1)
        .max(500)
        .describe('Wallet addresses (max 500).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().charactersBatch(args)),
  },
  {
    name: 'characters_tribe',
    title: 'Get a tribe',
    description:
      'A tribe — the game-world faction a character belongs to, not an on-chain organization (those are org_*) — by numeric id, as carried in a character’s tribeId: name, short name, description, tax rate and URL. Fails with TribeNotFound for an unknown id. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'characters.tribe',
    inputShape: {
      tribeId: z
        .number()
        .int()
        .nonnegative()
        .describe('Numeric tribe id, e.g. 98000001.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().tribe(args.tribeId)),
  },

  // ─── World reference data ─────────────────────────────────────────────────
  {
    name: 'world_items',
    title: 'List the item catalogue',
    description:
      'The full curated EVE Frontier item list (about 1–2k items, ~100 KB): assetId, name, group, category and physical attributes. Static data that changes only with game releases — fetch once and cache rather than calling per item. To find one item by name use market_search_items. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'world.items',
    inputShape: {},
    handler: async (ctx) => ok(await ctx.readClient().worldItems()),
  },
  {
    name: 'world_item',
    title: 'Name an item',
    description:
      'Display name and group for one item asset id — the cheap way to label an assetId from an order book or trade. Fails with ItemNotFound for an unknown id. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'world.item',
    inputShape: {
      assetId: z.string().min(1).describe('Item asset id, e.g. "77800".'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().worldItem(args.assetId)),
  },
  {
    name: 'world_recipes',
    title: 'List crafting recipes',
    description:
      'Every crafting recipe: product, output quantity, craft time in seconds (null when unknown) and the input materials with quantities. Static data — fetch once and cache; for one product use world_recipes_for. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'world.recipes',
    inputShape: {},
    handler: async (ctx) => ok(await ctx.readClient().recipes()),
  },
  {
    name: 'world_recipes_for',
    title: 'Get recipes for an item',
    description:
      'The recipes that produce one item — its bill of materials. [] means nothing crafts it, which is an answer, not an error. Pair with market_display_prices over the material ids to cost a build. Costs 20 CU.',
    kind: 'read',
    sdkPath: 'world.recipesFor',
    inputShape: {
      productAssetId: z
        .string()
        .min(1)
        .describe('Asset id of the item to craft, e.g. "77753".'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().recipesFor(args.productAssetId)),
  },
]
