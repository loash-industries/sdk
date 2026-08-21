/**
 * Wire-format fixtures below mirror the pinned etl-api spec
 * (dynamic-config-registry/upstream-specs/etl-api.json) — field names, casing,
 * and string-encoded integers are exactly what the gateway returns.
 */
import {
  DiscoveryResultSchema,
  HubItemsPageSchema,
  HubLocationSchema,
  HubVaultSchema,
  InventoryBalancesSchema,
  OpenOrdersPageSchema,
  OrderbookSchema,
  FillsPageSchema,
  PoolMetadataSchema,
  PoolResolveSchema,
  TradesPageSchema,
  parseWith,
} from '../src/schemas'
import { TriexClientError, TriexError } from '../src/errors'

const HEX = '0x7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8'
const MAX_U64 = '18446744073709551615'

describe('DiscoveryResultSchema', () => {
  it('maps the snake_case page into camelCase orders with bigints', () => {
    const parsed = DiscoveryResultSchema.parse({
      data: [
        {
          pool_id: HEX,
          order_id: '42',
          price: '1500',
          is_bid: true,
          balance_manager_id: HEX,
          remaining_quantity: '7',
          filled_quantity: '3',
          expires_at: null,
          last_activity_at: 1755043200000,
          asset_id: '70810',
          collection_id: HEX,
          hub_id: null,
          hub_name: null,
          hub_state: 'online',
          quote_asset_id: '0x9f::cred::CRED',
          quote_asset_symbol: 'CRED',
          quote_asset_decimals: 9,
          trader_address: null,
          trader_name: null,
        },
      ],
      next_cursor: 'MTAw',
      prev_cursor: null,
    })
    expect(parsed.orders).toHaveLength(1)
    const o = parsed.orders[0]
    expect(o.poolId).toBe(HEX)
    expect(o.price).toBe(1500n)
    expect(o.isBid).toBe(true)
    expect(o.remainingQuantity).toBe(7n)
    expect(o.expiresAt).toBeNull() // GTC
    expect(o.lastActivityAt).toBe(1755043200000)
    expect(parsed.nextCursor).toBe('MTAw')
    expect(parsed.prevCursor).toBeNull()
  })
})

describe('PoolResolveSchema', () => {
  it('passes through a resolved pool and a null miss', () => {
    expect(PoolResolveSchema.parse({ pool_id: HEX }).poolId).toBe(HEX)
    expect(PoolResolveSchema.parse({ pool_id: null }).poolId).toBeNull()
  })
})

describe('OrderbookSchema', () => {
  it('parses resting orders and derives remainingQuantity', () => {
    const parsed = OrderbookSchema.parse({
      bids: [
        {
          encodedOrderId: '170141183460469231731687303715884105728',
          quantity: '10',
          filledQuantity: '4',
          expireTimestamp: MAX_U64,
          lastUpdatedTimestamp: '1755043200000',
          epoch: '0',
          status: 0,
          price: '1500',
        },
      ],
      asks: [],
    })
    const bid = parsed.bids[0]
    expect(bid.orderId).toBe('170141183460469231731687303715884105728')
    expect(bid.quantity).toBe(10n)
    expect(bid.remainingQuantity).toBe(6n)
    expect(bid.expireTimestamp).toBe(BigInt(MAX_U64)) // GTC survives as bigint
    expect(bid.price).toBe(1500n)
    expect(parsed.asks).toEqual([])
  })
})

describe('PoolMetadataSchema', () => {
  const base = {
    pool_id: HEX,
    pool_name: 'Carbon / CRED',
    base_asset_symbol: 'CARBON',
    base_asset_name: 'Carbon',
    base_asset_decimals: 0,
    quote_asset_symbol: 'CRED',
    quote_asset_name: null,
    quote_asset_decimals: 9,
    storage_unit_id: HEX,
    asset_id: '70810',
    collection_id: HEX,
  }

  it('converts the 1e9-scaled fee string to bigint', () => {
    const parsed = PoolMetadataSchema.parse({
      ...base,
      fee: '20000000',
      fee_rate: 0.02,
    })
    expect(parsed.feeRateScaled).toBe(20_000_000n)
    expect(parsed.feeRate).toBe(0.02)
    expect(parsed.quoteAssetDecimals).toBe(9)
  })

  it('treats a null fee as 0n', () => {
    const parsed = PoolMetadataSchema.parse({ ...base, fee: null, fee_rate: null })
    expect(parsed.feeRateScaled).toBe(0n)
  })
})

describe('hub schemas', () => {
  it('parses the vault descriptor', () => {
    const parsed = HubVaultSchema.parse({
      hub_id: HEX,
      collection_id: HEX,
      vault_config_id: HEX,
    })
    expect(parsed.vaultConfigId).toBe(HEX)
  })

  it('parses the location / ownership record', () => {
    const parsed = HubLocationSchema.parse({
      hub_id: HEX,
      assembly_item_id: '123456',
      assembly_tenant: 'stillness',
      type_id: '88001',
      owner_cap_id: HEX,
      owner: null,
      solar_system: '30000142',
      x: '-1.2e18',
      y: '0',
      z: '99',
      updated_at: 1755043200000,
      tx_digest: 'digest',
      is_public: true,
      region_id: null,
      solar_system_name: 'Nod',
    })
    expect(parsed.isPublic).toBe(true)
    expect(parsed.solarSystemId).toBe('30000142')
    expect(parsed.ownerCapId).toBe(HEX)
  })

  it('parses the items page', () => {
    const parsed = HubItemsPageSchema.parse({
      data: [{ asset_id: '70810', has_bids: true, has_asks: false }],
      next_cursor: null,
    })
    expect(parsed.items[0]).toEqual({
      assetId: '70810',
      hasBids: true,
      hasAsks: false,
    })
    expect(parsed.nextCursor).toBeNull()
  })
})

describe('InventoryBalancesSchema', () => {
  it('parses all four balance sections', () => {
    const parsed = InventoryBalancesSchema.parse({
      storage_unit_id: HEX,
      collection_id: HEX,
      warehouse: [{ asset_id: '70810', amount: '5' }],
      marketplace: [{ asset_id: '70810', amount: '11' }],
      hangar: [],
      org_vaults: { [HEX]: [{ asset_id: '70810', amount: '2' }] },
    })
    expect(parsed.warehouse[0]).toEqual({ assetId: '70810', amount: 5n })
    expect(parsed.marketplace[0].amount).toBe(11n)
    expect(parsed.hangar).toEqual([])
    expect(parsed.orgVaults[HEX][0].amount).toBe(2n)
  })
})

describe('order-status schemas', () => {
  it('parses an open-orders page (encoded_order_id optional)', () => {
    const parsed = OpenOrdersPageSchema.parse({
      data: [
        {
          pool_id: HEX,
          order_id: '170141211044891661156',
          side: 'buy',
          price: '1500',
          remaining_quantity: '7',
          filled_quantity: '3',
          expires_at: 1755043200000,
          updated_at: 1755043100000,
          asset_id: '77800',
          storage_unit_id: HEX,
          quote_asset_symbol: 'CRED',
          quote_asset_decimals: 9,
        },
      ],
      next_cursor: null,
    })
    expect(parsed.orders[0].side).toBe('buy')
    expect(parsed.orders[0].encodedOrderId).toBeUndefined()
    expect(parsed.orders[0].remainingQuantity).toBe(7n)
  })

  it('parses a fills page', () => {
    const parsed = FillsPageSchema.parse({
      data: [
        {
          event_digest: 'abc:0',
          pool_id: HEX,
          order_id: '9',
          counterparty_balance_manager_id: HEX,
          price: '1500',
          base_quantity: '2',
          quote_quantity: '3000',
          fee: '60',
          role: 'maker',
          taker_is_bid: true,
          filled_at: 1755043200000,
        },
      ],
      next_cursor: 'x',
    })
    expect(parsed.fills[0].quoteQuantity).toBe(3000n)
    expect(parsed.fills[0].fee).toBe(60n)
    expect(parsed.fills[0].role).toBe('maker')
  })

  it('parses a trades page', () => {
    const parsed = TradesPageSchema.parse({
      data: [
        {
          event_digest: 'abc:1',
          pool_id: HEX,
          order_id: '9',
          counterparty_balance_manager_id: HEX,
          price: '1500',
          base_quantity: '2',
          quote_quantity: '3000',
          fee: '0',
          role: 'taker',
          side: 'sell',
          traded_at: 1755043200000,
          asset_id: '77800',
          storage_unit_id: HEX,
        },
      ],
      next_cursor: null,
    })
    expect(parsed.trades[0].side).toBe('sell')
    expect(parsed.trades[0].tradedAt).toBe(1755043200000)
  })
})

describe('parseWith', () => {
  it('wraps zod failures in a typed TriexClientError', () => {
    try {
      parseWith(HubVaultSchema, { nope: true }, 'hubVault')
      throw new Error('expected parseWith to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(TriexClientError)
      expect((e as TriexClientError).code).toBe(TriexError.UnexpectedResponse)
      expect((e as TriexClientError).message).toContain('hubVault')
    }
  })
})
