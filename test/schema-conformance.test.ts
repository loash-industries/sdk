/**
 * Every response schema the SDK pins, checked against the gateway's published
 * contract — mechanically, not by hand-copied fixtures.
 *
 * For each wrapped operation, payloads are SYNTHESISED from the operation's
 * OpenAPI response schema and parsed with the SDK's zod schema:
 *
 * - **minimal** — only the spec's `required` fields, every nullable one null.
 *   Fails when the SDK requires a field the spec lets the gateway omit, or
 *   rejects a null the spec allows: the drift that throws on live data.
 * - **full** — every declared field, with the spec's `example` values where it
 *   has them. Fails when the SDK mistypes a field that does arrive.
 *
 * The spec's own response examples are parsed as well. Together with the
 * gateway gate (which checks requests), this pins both directions of the wire
 * against the same vendored document.
 */
import { z } from 'zod'
import { loadSpec } from '../scripts/gateway-surface.mjs'
import {
  AssemblyEnrichedSchema,
  AssemblyOwnerSchema,
  AutocompleteSystemsSchema,
  BatchSystemsSchema,
  CharacterLookupSchema,
  CharacterSchema,
  CollectionHubSchema,
  CoordinateSearchSchema,
  DiscoveryResultSchema,
  DisplayPricesSchema,
  FillDetailSchema,
  FillsPageSchema,
  HubEconomicsSchema,
  HubEnrichedSchema,
  HubItemOrderbookSchema,
  HubItemsPageSchema,
  HubLocationPageSchema,
  HubLocationSchema,
  HubVaultSchema,
  InventoryBalancesSchema,
  ItemInfoSchema,
  ItemSearchPageSchema,
  NearbyHubSchema,
  NearbySystemsSchema,
  OpenOrdersPageSchema,
  OrderbookSchema,
  OrderDetailSchema,
  PlatformStatsSchema,
  PoolFeesSchema,
  PoolMetadataSchema,
  PoolResolveSchema,
  RecentTradesPageSchema,
  RecipeSchema,
  RouteComparisonSchema,
  RouteSchema,
  RoutingStatsSchema,
  SolarSystemNameSchema,
  SolarSystemSchema,
  SpatialStatsSchema,
  SweepableSchema,
  TradesPageSchema,
  TradingAccountOwnerSchema,
  TribeSchema,
  WorldItemSchema,
} from '../src/schemas'

/** operationId → the schema the SDK parses that operation's 200 with. */
const SDK_SCHEMAS: Record<string, z.ZodType> = {
  // market data
  getDiscovery: DiscoveryResultSchema,
  resolvePool: PoolResolveSchema,
  getPoolOrderbook: OrderbookSchema,
  getPoolMetadata: PoolMetadataSchema,
  getHubItemOrderbook: HubItemOrderbookSchema,
  getPoolOrder: OrderDetailSchema,
  getFill: FillDetailSchema,
  getRecentTrades: RecentTradesPageSchema,
  listDisplayPrices: DisplayPricesSchema,
  getDisplayPrice: DisplayPricesSchema,
  batchGetHubEconomics: z.array(HubEconomicsSchema),
  listTopPoolsByFees: z.array(PoolFeesSchema),
  getStats: PlatformStatsSchema,
  // hubs & locations
  getHubVault: HubVaultSchema,
  getHubLocation: HubLocationSchema,
  listHubLocations: HubLocationPageSchema,
  listItemLocations: HubLocationPageSchema,
  listHubsNearHub: z.array(NearbyHubSchema),
  listHubsNearSolarSystem: z.array(NearbyHubSchema).nullable(),
  batchGetHubs: z.array(HubEnrichedSchema),
  listHubItems: HubItemsPageSchema,
  getCollectionHub: CollectionHubSchema,
  batchGetAssemblyOwners: z.array(AssemblyOwnerSchema),
  batchGetAssemblies: z.array(AssemblyEnrichedSchema),
  batchGetTradingAccountOwners: z.array(TradingAccountOwnerSchema),
  batchGetSolarSystemNames: z.array(SolarSystemNameSchema),
  // account
  getInventoryBalances: InventoryBalancesSchema,
  listAccountOpenOrders: OpenOrdersPageSchema,
  listAccountFills: FillsPageSchema,
  listAccountTrades: TradesPageSchema,
  listAccountSweepable: SweepableSchema,
  // characters & world
  getCharacter: CharacterSchema,
  getCharacterByAddress: z.array(CharacterSchema),
  getCharacterByName: z.array(CharacterSchema),
  batchGetCharacters: z.array(CharacterLookupSchema),
  getTribe: TribeSchema,
  listItems: z.array(WorldItemSchema),
  getAsset: ItemInfoSchema,
  searchAssets: ItemSearchPageSchema,
  listRecipes: z.array(RecipeSchema),
  getRecipe: z.array(RecipeSchema),
  // star map & routing
  getSolarSystem: SolarSystemSchema,
  batchGetSolarSystems: BatchSystemsSchema,
  listSystemsNearSolarSystem: NearbySystemsSchema,
  listSystemsNearCoordinates: CoordinateSearchSchema,
  autocompleteSolarSystems: AutocompleteSystemsSchema,
  getStarMapStats: SpatialStatsSchema,
  getRoute: RouteSchema,
  compareRoutes: RouteComparisonSchema,
  getRoutingStats: RoutingStatsSchema,
}

/**
 * Operations whose responses another module pins: Armature (orgs, players,
 * hub DAO vaults) has its own schemas and tests, and coin markets are the
 * coin-pool module's. The deprecated tribe alias shares `getTribe`'s shape.
 */
const PINNED_ELSEWHERE = new Set([
  'listCoins',
  'getTribeLegacy',
  'batchGetOrgs',
  'getOrg',
  'listOrgDirectory',
  'listOrgProposals',
  'listPlayerOrgs',
  'listAccessibleKeyspaces',
  'listHubDaoVaults',
  'search',
])

type Json = any
const spec = loadSpec()
const components: Record<string, Json> = spec.components?.schemas ?? {}

function resolve(node: Json): Json {
  let n = node
  for (let i = 0; i < 20 && n && n.$ref; i++) {
    n = components[n.$ref.split('/').pop()]
  }
  return n
}

/** Is `node` (as a property) allowed to be null? Covers 3.0 and 3.1 forms. */
function nullable(node: Json): boolean {
  if (!node) return false
  if (node.nullable) return true
  if (Array.isArray(node.type) && node.type.includes('null')) return true
  const alts = node.oneOf ?? node.anyOf
  return Array.isArray(alts) && alts.some((a: Json) => a?.type === 'null')
}

/** Unwrap allOf/oneOf/anyOf wrappers to the concrete schema. */
function concrete(node: Json): Json {
  let n = resolve(node)
  for (let i = 0; i < 10 && n; i++) {
    const alts = n.allOf ?? n.oneOf ?? n.anyOf
    if (!alts) break
    n = resolve(alts.find((a: Json) => a?.type !== 'null') ?? alts[0])
  }
  return n
}

function primitive(node: Json, type: string): Json {
  if (node.example !== undefined) return node.example
  if (node.enum) return node.enum[0]
  switch (type) {
    case 'integer':
    case 'number':
      return 1
    case 'boolean':
      return true
    default:
      // A digit string satisfies both plain strings and decimal-string
      // integers, which the spec types as `string` throughout.
      return '1'
  }
}

/** Build a payload from a schema node. */
function synth(node: Json, mode: 'minimal' | 'full', depth = 0): Json {
  const n = concrete(node)
  if (!n || depth > 12) return null
  const type = Array.isArray(n.type)
    ? n.type.find((t: string) => t !== 'null')
    : n.type
  if (type === 'array') return [synth(n.items, mode, depth + 1)]
  if (type === 'object' || n.properties) {
    const out: Record<string, Json> = {}
    const required = new Set<string>(n.required ?? [])
    for (const [key, prop] of Object.entries<Json>(n.properties ?? {})) {
      if (mode === 'minimal') {
        if (!required.has(key)) continue
        out[key] = nullable(prop) ? null : synth(prop, mode, depth + 1)
      } else {
        out[key] = synth(prop, mode, depth + 1)
      }
    }
    return out
  }
  return primitive(n, type ?? 'string')
}

interface Op {
  operationId: string
  path: string
  schema: Json
  examples: Json[]
}

const operations: Op[] = []
for (const [path, item] of Object.entries<Json>(spec.paths)) {
  for (const [method, op] of Object.entries<Json>(item)) {
    if (method !== 'get') continue
    const content = op.responses?.['200']?.content?.['application/json']
    operations.push({
      operationId: op.operationId,
      path,
      schema: content?.schema,
      examples: [
        ...(content?.example !== undefined ? [content.example] : []),
        ...Object.values<Json>(content?.examples ?? {}).map((e) => e.value),
      ],
    })
  }
}

describe('response schemas conform to the published contract', () => {
  it('pins a schema for every published operation not pinned elsewhere', () => {
    const unpinned = operations
      .filter(
        (op) =>
          !SDK_SCHEMAS[op.operationId] && !PINNED_ELSEWHERE.has(op.operationId),
      )
      .map((op) => `${op.operationId} (${op.path})`)
    expect(unpinned).toEqual([])
  })

  const pinned = operations.filter((op) => SDK_SCHEMAS[op.operationId])

  it.each(pinned.map((op) => [op.operationId, op] as const))(
    '%s parses a minimal and a full payload synthesised from the spec',
    (_id, op) => {
      const schema = SDK_SCHEMAS[op.operationId]
      for (const mode of ['minimal', 'full'] as const) {
        const payload = synth(op.schema, mode)
        const result = schema.safeParse(payload)
        if (!result.success) {
          throw new Error(
            `${op.operationId} (${mode}) does not parse: ${result.error.message}\n` +
              `payload: ${JSON.stringify(payload)}`,
          )
        }
      }
    },
  )

  it('fails a schema that requires what the spec lets be null', () => {
    // The real drift this caught: `SweepableItem.storage_unit_id` became
    // nullable upstream while the SDK still required a string, so one
    // unlinked item failed the whole sweep manifest.
    const strict = z.object({ storage_unit_id: z.string() })
    const minimal = synth(
      { $ref: '#/components/schemas/SweepableItem' },
      'minimal',
    )
    expect(minimal.storage_unit_id).toBeNull()
    expect(strict.safeParse(minimal).success).toBe(false)
  })

  const withExamples = pinned.filter((op) => op.examples.length)

  it('the contract carries response examples to check', () => {
    expect(withExamples.length).toBeGreaterThan(0)
  })

  it.each(withExamples.map((op) => [op.operationId, op] as const))(
    '%s parses the spec’s own response example',
    (_id, op) => {
      for (const example of op.examples) {
        expect(SDK_SCHEMAS[op.operationId].safeParse(example).success).toBe(
          true,
        )
      }
    },
  )
})
