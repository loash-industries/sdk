/**
 * Response fields the gateway added after the 2026-10-01 contract. zod strips
 * unknown keys, so without these mappings callers simply never see them.
 */
import {
  OrderbookSchema,
  PoolMetadataSchema,
  TradesPageSchema,
} from '../src/schemas'
import { ProposalSummarySchema } from '../src/armature/schemas'
import { CoinListSchema } from '../src/coins/schemas'

const HEX = `0x${'7f'.repeat(32)}`
const CRED = '0x9f3a::cred::CRED'

describe('fields added upstream', () => {
  it('pool metadata carries the maker fee', () => {
    const meta = PoolMetadataSchema.parse({
      pool_id: HEX,
      pool_name: 'X/CRED',
      base_asset_symbol: 'X',
      base_asset_name: null,
      base_asset_decimals: 0,
      quote_asset_symbol: 'CRED',
      quote_asset_name: null,
      quote_asset_decimals: 9,
      storage_unit_id: null,
      asset_id: null,
      collection_id: null,
      fee: '22000000',
      fee_rate: 0.022,
      maker_fee: '18000000',
      maker_fee_rate: 0.018,
    })
    expect(meta).toMatchObject({
      feeRateScaled: 22_000_000n,
      makerFeeRateScaled: 18_000_000n,
      makerFeeRate: 0.018,
    })
  })

  it('order-book orders name their account and last checkpoint', () => {
    const book = OrderbookSchema.parse({
      bids: [
        {
          encodedOrderId: '9',
          quantity: '5',
          filledQuantity: '1',
          expireTimestamp: '0',
          lastUpdatedTimestamp: '0',
          epoch: '1',
          status: 0,
          price: '100',
          tradingAccountId: HEX,
          lastCheckpoint: '410269239',
        },
      ],
      asks: [],
    })
    expect(book.bids[0]).toMatchObject({
      tradingAccountId: HEX,
      lastCheckpoint: 410269239n,
      remainingQuantity: 4n,
    })
  })

  it('account trades name the counterparty', () => {
    const page = TradesPageSchema.parse({
      data: [
        {
          event_digest: 'd:0',
          pool_id: HEX,
          order_id: '9',
          counterparty_trading_account_id: HEX,
          price: '1',
          base_quantity: '1',
          quote_quantity: '1',
          fee: '0',
          role: 'maker',
          side: 'sell',
          traded_at: 1,
          asset_id: '1',
          storage_unit_id: HEX,
          counterparty: {
            trading_account_id: HEX,
            kind: 'org',
            id: HEX,
            name: 'Guild',
            root_org_id: HEX,
            root_org_name: 'Guild',
          },
        },
      ],
      next_cursor: null,
    })
    expect(page.trades[0].counterparty).toMatchObject({
      kind: 'org',
      name: 'Guild',
    })
  })

  it('proposals keep their payload bytes and execution record', () => {
    const p = ProposalSummarySchema.parse({
      proposal_id: HEX,
      org_id: HEX,
      type_key: null,
      proposer: null,
      status: 'executed',
      yes_weight: 1,
      no_weight: 0,
      payload_type: '0x2::send_coin::SendCoin',
      frame_id: null,
      created_checkpoint: 1,
      payload_bcs: 'AAE=',
      executor: HEX,
      executed_ms: 1775739423394,
    })
    expect(p).toMatchObject({
      payloadBcs: 'AAE=',
      executor: HEX,
      executedMs: 1775739423394,
    })
  })

  it('reads the current coin market shape, base fields from the coin', () => {
    const [coin] = CoinListSchema.parse([
      {
        coin_type: CRED,
        symbol: 'CRED',
        name: 'Cred',
        decimals: 9,
        icon_url: null,
        total_supply: null,
        circulating: null,
        treasury_holdings: null,
        max_supply: null,
        mint_policy: null,
        immutable: null,
        upgradeable: true,
        market: {
          pool_id: HEX,
          quote_asset_id: CRED,
          quote_asset_symbol: 'CRED',
          quote_asset_decimals: 9,
          best_bid: '100',
          best_ask: null,
          last_price: '110',
          last_traded_at: 5,
          open_orders: 3,
          traders: 2,
          price_change_24h: 0.0372,
        },
      },
    ])
    expect(coin.verified).toBeNull()
    expect(coin.market).toMatchObject({
      poolId: HEX,
      baseCoinType: CRED,
      baseSymbol: 'CRED',
      baseDecimals: 9,
      quoteCoinType: CRED,
      bestBid: 100n,
      bestAsk: null,
      lastPrice: 110n,
      priceChange24h: 0.0372,
      poolName: null,
      feeRateScaled: null,
    })
  })
})
