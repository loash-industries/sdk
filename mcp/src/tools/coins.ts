import { z } from 'zod'
import { ok } from '../result.js'
import {
  big,
  bigOpt,
  coinPoolSelectorShape,
  coinType,
  objectId,
  orderSide,
  suiAddress,
  u64,
} from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Coin-pool (currency-pair) market reads — `triex::pool::Pool<Base, Quote>`,
 * a CLOB between two Move coin types, as opposed to the item markets the
 * `market_*` tools read.
 *
 * Only `coins_list` is an indexer read. Everything else is a head-current
 * fullnode simulation (the coin-pool indexer routes are not on the public
 * gateway), served through the shared, credential-free Sui client the read
 * client carries.
 *
 * Units: every amount is RAW base units of its coin as a decimal string, and
 * prices are 1e9-scaled raw (`quote = floor(base × price / 1e9)`), not the
 * item markets' CRED-per-item.
 */

const tradingAccountId = objectId.describe(
  'TradingAccount object id — from account_resolve.',
)

export const coinTools: ToolDef[] = [
  {
    name: 'coins_list',
    title: 'List coins',
    description:
      'Every coin in the token registry with supply facts and, when it has one, its pool’s market summary (pool id, base/quote coin types and decimals, best bid/ask, last price, entry taker rate) — pooled coins first, most active first. The entry point for coin trading: it turns a symbol into the coin type and pool id every other coins_* and prepare_coin_* tool takes. Supply figures are whole coins; prices and rates are raw 1e9-scaled decimal strings and display-only — use coins_trade_params for live fees.',
    kind: 'read',
    sdkPath: 'coins.list',
    inputShape: {
      coinTypes: z
        .array(coinType)
        .min(1)
        .max(200)
        .optional()
        .describe('Restrict to these coin types (max 200). Omit for all.'),
    },
    handler: async (ctx, args) =>
      ok(
        await ctx
          .readClient()
          .coins.list(args.coinTypes ? { coinTypes: args.coinTypes } : {}),
      ),
  },
  {
    name: 'coins_orderbook',
    title: 'Read a coin order book',
    description:
      'The resting book of one coin pool, read on-chain: bids and asks best-first (expired orders excluded) with order ids, plus per-price levels and whether more rests beyond the depth read. Also echoes the resolved poolId and coin types. Prices are 1e9-scaled raw, quantities raw base units. Use before sizing a coin limit or market order.',
    kind: 'read',
    sdkPath: 'coins.orderbook',
    inputShape: {
      ...coinPoolSelectorShape,
      depth: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe('Orders to read per side (default 100).'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().coins.orderbook(args)),
  },
  {
    name: 'coins_trade_params',
    title: 'Read coin-pool fees',
    description:
      'Live fee state of one coin pool from the on-chain FeePolicy: the pool’s fee class, entry-rung taker/maker rates, the staged schedule and the epoch it takes over, and the share of a bid’s maker-fee escrow kept on cancel. With tradingAccountId, also that account’s tier, turnover and rates. Rates are 1e9-scaled (11000000 = 1.10%). prepare_coin_limit_order funds bids from exactly these rates.',
    kind: 'read',
    sdkPath: 'coins.tradeParams',
    inputShape: {
      ...coinPoolSelectorShape,
      tradingAccountId: tradingAccountId
        .optional()
        .describe('Also resolve this trading account’s own tier and rates.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().coins.tradeParams(args)),
  },
  {
    name: 'coins_quote',
    title: 'Quote a coin swap',
    description:
      'Dry-run a wallet swap against the live book, fees included: what amountIn buys (side "buy", spending quote) or sells for (side "sell", spending base), and how much of it the book could not absorb. Priced at the entry rung — exactly what prepare_coin_swap is charged — unless tradingAccountId is given. Raw base units as decimal strings; nothing executes.',
    kind: 'read',
    sdkPath: 'coins.quote',
    inputShape: {
      ...coinPoolSelectorShape,
      side: orderSide.describe(
        '"buy" spends quote for base; "sell" the reverse.',
      ),
      amountIn: u64.describe(
        'Raw amount of the coin being spent: quote for buys, base for sells.',
      ),
      tradingAccountId: tradingAccountId
        .optional()
        .describe(
          'Price at this account’s fee tier instead of the entry rung.',
        ),
    },
    handler: async (ctx, args) =>
      ok(
        await ctx
          .readClient()
          .coins.quote({ ...args, amountIn: big(args.amountIn) }),
      ),
  },
  {
    name: 'coins_estimate_market',
    title: 'Estimate a coin market order',
    description:
      'Price a coin market order of `quantity` base against the live book exactly as matching will: filled quantity, gross quote, taker fee, average price, and totalQuote — for a buy, the quote the trading account must hold (pass it as quoteBudget to prepare_coin_market_order); for a sell, what it nets. Raw units; prices 1e9-scaled.',
    kind: 'read',
    sdkPath: 'coins.estimateMarket',
    inputShape: {
      ...coinPoolSelectorShape,
      side: orderSide,
      quantity: u64.describe('Base quantity of the market order, raw units.'),
      depth: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe('Book depth to walk (default 100, the matching limit).'),
      takerFeeRateScaled: u64
        .optional()
        .describe(
          'Taker rate to price at, 1e9-scaled. Defaults to the conservative entry-rung rate.',
        ),
    },
    handler: async (ctx, args) =>
      ok(
        await ctx.readClient().coins.estimateMarket({
          ...args,
          quantity: big(args.quantity),
          takerFeeRateScaled: bigOpt(args.takerFeeRateScaled),
        }),
      ),
  },
  {
    name: 'coins_open_orders',
    title: 'List coin open orders',
    description:
      'A trading account’s resting orders in one coin pool, read on-chain — order ids (u128 decimal strings), price, original/filled/remaining quantity, expiry. Empty when it has none. These ids feed prepare_coin_cancel_order and prepare_coin_modify_order.',
    kind: 'read',
    sdkPath: 'coins.openOrders',
    inputShape: { ...coinPoolSelectorShape, tradingAccountId },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().coins.openOrders(args)),
  },
  {
    name: 'coins_account',
    title: 'Read coin-pool account state',
    description:
      'A trading account’s state in one coin pool: open order ids, taker/maker volume, settled balances (claimable now via prepare_coin_claim_settled), owed balances, and what its open orders lock. Null when the account has never traded in this pool. Raw base units as decimal strings.',
    kind: 'read',
    sdkPath: 'coins.account',
    inputShape: { ...coinPoolSelectorShape, tradingAccountId },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().coins.account(args)),
  },
  {
    name: 'coins_balances',
    title: 'Check coin balances',
    description:
      'Any coin held by an address: loose in the wallet, and deposited inside its trading account — the any-coin form of account_currency_balances. Works for an address with no trading account (tradingAccount "0", tradingAccountId null). Head-current from the fullnode; raw base units as decimal strings.',
    kind: 'read',
    sdkPath: 'coins.balances',
    inputShape: {
      coinType: coinType.describe('Coin type to read, e.g. "0x2::sui::SUI".'),
      address: suiAddress.describe('Sui address whose balances to read.'),
    },
    handler: async (ctx, args) =>
      ok(await ctx.readClient().coins.balances(args)),
  },
]
