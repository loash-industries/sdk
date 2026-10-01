import { normalizeStructTag } from '@mysten/sui/utils'
import {
  COIN_POOL_CREATION_FEE,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  computeCoinBidDeposit,
  conservativeBidFeeRate,
} from '@trinaryex/sdk'
import type { CoinPool, CoinPoolSelector, TriexClient } from '@trinaryex/sdk'
import { z } from 'zod'
import {
  big,
  bigOpt,
  coinPoolSelectorShape,
  coinType,
  orderSide,
  senderShape,
  u64,
} from '../schemas.js'
import { PREPARE_SUFFIX, orderIdSchema, prepared, spend } from './prepare.js'
import type { ToolDef } from './types.js'

/**
 * Coin-pool (currency-pair) writes, prepared unsigned — the `client.coins`
 * mirror of the item-market `prepare_*` tools.
 *
 * Every amount is RAW base units of its coin, and prices are 1e9-scaled raw.
 * `worstCaseSpend.asset` is the full, normalized coin type rather than a
 * symbol, because a coin pool may be quoted in something other than CRED.
 *
 * Where the SDK would size a figure itself from a live read (a bid's deposit,
 * a market buy's budget, a swap's minimum output), these tools run that read
 * first and pass the result in explicitly — the same formula the SDK applies,
 * but it means the number the bytes commit to is the number `intent` declares.
 */

/** The selector fields the caller gave, without undefined keys. */
function selectorOf(args: Record<string, unknown>): CoinPoolSelector {
  return {
    ...(args.poolId ? { poolId: args.poolId as string } : {}),
    ...(args.baseCoinType ? { baseCoinType: args.baseCoinType as string } : {}),
    ...(args.quoteCoinType
      ? { quoteCoinType: args.quoteCoinType as string }
      : {}),
  }
}

/**
 * Resolve the pool once on the client that will build the write. Passing the
 * full `{ poolId, baseCoinType, quoteCoinType }` back in makes the SDK skip its
 * own lookups, and gives the intent the coin types it must name.
 */
function resolvePool(
  client: TriexClient,
  args: Record<string, unknown>,
): Promise<CoinPool> {
  return client.coins.resolvePool(selectorOf(args))
}

/** Normalize a coin type for the intent; the SDK rejects a bad one anyway. */
function normalizeType(type: string): string {
  try {
    return normalizeStructTag(type)
  } catch {
    return type
  }
}

const poolParams = (pool: CoinPool) => ({
  poolId: pool.poolId,
  baseCoinType: pool.baseCoinType,
  quoteCoinType: pool.quoteCoinType,
})

const orderType = z
  .number()
  .int()
  .min(0)
  .max(3)
  .optional()
  .describe('0=LIMIT (default), 1=IOC, 2=FOK, 3=POST_ONLY.')

const selfMatchingOption = z
  .number()
  .int()
  .min(0)
  .max(2)
  .optional()
  .describe('0=allowed (default), 1=cancel taker, 2=cancel maker.')

export const coinPrepareTools: ToolDef[] = [
  {
    name: 'prepare_coin_deposit',
    title: 'Prepare: deposit a coin',
    description:
      'Build a deposit of any coin from the wallet into the trading account, creating the account in the same transaction when the sender has none. SUI is split from the gas coin. The any-coin form of prepare_deposit_currency.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.deposit',
    inputShape: {
      ...senderShape,
      coinType: coinType.describe('Coin type to deposit.'),
      amount: u64.describe('Raw base units of that coin.'),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'coin_deposit',
          params: {
            coinType: normalizeType(args.coinType),
            amount: args.amount,
          },
          worstCaseSpend: spend(normalizeType(args.coinType), args.amount),
        },
        () =>
          ctx.writeClient(args.sender).coins.deposit({
            coinType: args.coinType,
            amount: big(args.amount),
          }),
      ),
  },
  {
    name: 'prepare_coin_withdraw',
    title: 'Prepare: withdraw a coin',
    description:
      'Build a withdrawal of any coin from the trading account back to the wallet. Omit amount to withdraw the whole balance. Settled pool proceeds must be claimed into the account first (prepare_coin_claim_settled).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.withdraw',
    inputShape: {
      ...senderShape,
      coinType: coinType.describe('Coin type to withdraw.'),
      amount: u64
        .optional()
        .describe('Raw base units; omit for the full balance.'),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'coin_withdraw',
          params: {
            coinType: normalizeType(args.coinType),
            amount: args.amount ?? 'full balance',
          },
        },
        () =>
          ctx.writeClient(args.sender).coins.withdraw({
            coinType: args.coinType,
            ...(args.amount !== undefined ? { amount: big(args.amount) } : {}),
          }),
      ),
  },
  {
    name: 'prepare_coin_limit_order',
    title: 'Prepare: coin limit order',
    description:
      'Build a coin-pool limit order in one atomic transaction: creates the trading account if missing, deposits only the deficit, and places the order (good-til-cancelled by default). A sell deposits base; a buy deposits quote plus a fee at the highest entry-rung rate (taker or maker, active or staged — see coins_trade_params), so it is never under-funded and the unused part stays in the account. price is 1e9-scaled raw (quote = floor(quantity × price / 1e9)); quantity must be at least ceil(1e9 / price).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.limit',
    inputShape: {
      ...senderShape,
      ...coinPoolSelectorShape,
      side: orderSide,
      price: u64.describe('Raw 1e9-scaled price, in [1, 2^63−1].'),
      quantity: u64.describe('Base quantity, raw units.'),
      expireAt: u64
        .optional()
        .describe('Unix ms; omit for good-til-cancelled.'),
      orderType,
      selfMatchingOption,
      quoteDeposit: u64
        .optional()
        .describe(
          'Override the quote held for a buy. Defaults to the never-under-funded deposit.',
        ),
    },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      const isBid = args.side === 'buy'
      let quoteDeposit = bigOpt(args.quoteDeposit)
      if (isBid && quoteDeposit === undefined) {
        const tp = await client.coins.tradeParams(pool)
        quoteDeposit = computeCoinBidDeposit(
          big(args.price),
          big(args.quantity),
          conservativeBidFeeRate(tp.entry, tp.next),
        )
      }
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_limit_order',
          params: {
            ...poolParams(pool),
            side: args.side,
            price: args.price,
            quantity: args.quantity,
            expireAt: args.expireAt ?? 'good-til-cancelled',
          },
          worstCaseSpend: isBid
            ? spend(pool.quoteCoinType, String(quoteDeposit))
            : spend(pool.baseCoinType, args.quantity),
        },
        () =>
          client.coins.limit({
            ...pool,
            side: args.side,
            price: big(args.price),
            quantity: big(args.quantity),
            ...(args.expireAt ? { expireAt: big(args.expireAt) } : {}),
            ...(args.orderType !== undefined
              ? { orderType: args.orderType }
              : {}),
            ...(args.selfMatchingOption !== undefined
              ? { selfMatchingOption: args.selfMatchingOption }
              : {}),
            ...(quoteDeposit !== undefined ? { quoteDeposit } : {}),
          }),
      )
    },
  },
  {
    name: 'prepare_coin_market_order',
    title: 'Prepare: coin market order',
    description:
      'Build a coin-pool market order (immediate-or-cancel) in one atomic transaction, creating the trading account if missing. A sell deposits the base deficit and its taker fee comes out of the proceeds. A buy holds quoteBudget, defaulting to the exact cost against the current book (coins_estimate_market totalQuote) — if the book moves against you the whole transaction aborts, so pass extra headroom to tolerate that. Unfilled quantity is cancelled; unspent quote stays in the account.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.market',
    inputShape: {
      ...senderShape,
      ...coinPoolSelectorShape,
      side: orderSide,
      quantity: u64.describe('Base quantity, raw units.'),
      quoteBudget: u64
        .optional()
        .describe(
          'Buys only: quote to hold, including the taker fee. Defaults to the live estimate.',
        ),
      selfMatchingOption,
    },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      const isBid = args.side === 'buy'
      let quoteBudget = bigOpt(args.quoteBudget)
      if (isBid && quoteBudget === undefined) {
        const est = await client.coins.estimateMarket({
          ...pool,
          side: 'buy',
          quantity: big(args.quantity),
        })
        // An empty book leaves it unset: the SDK re-estimates and refuses
        // with its own "no asks" error rather than placing a zero budget.
        if (est.filledQuantity > 0n) quoteBudget = est.totalQuote
      }
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_market_order',
          params: {
            ...poolParams(pool),
            side: args.side,
            quantity: args.quantity,
          },
          ...(isBid
            ? quoteBudget !== undefined
              ? {
                  worstCaseSpend: spend(
                    pool.quoteCoinType,
                    quoteBudget.toString(),
                  ),
                }
              : {}
            : { worstCaseSpend: spend(pool.baseCoinType, args.quantity) }),
        },
        () =>
          client.coins.market({
            ...pool,
            side: args.side,
            quantity: big(args.quantity),
            ...(quoteBudget !== undefined ? { quoteBudget } : {}),
            ...(args.selfMatchingOption !== undefined
              ? { selfMatchingOption: args.selfMatchingOption }
              : {}),
          }),
      )
    },
  },
  {
    name: 'prepare_coin_swap',
    title: 'Prepare: coin swap',
    description:
      'Build a wallet-to-wallet swap through a coin pool — no trading account involved. "buy" spends amountIn of the quote coin for base; "sell" spends base for quote. Charged at the entry-rung taker rate; output and any input the book could not absorb come back to the wallet. minOut defaults to the coins_quote dry-run less slippageBps (default 50); the swap aborts below it. intent.params.minOut is the floor the bytes enforce.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.swap',
    inputShape: {
      ...senderShape,
      ...coinPoolSelectorShape,
      side: orderSide.describe(
        '"buy" spends quote for base; "sell" the reverse.',
      ),
      amountIn: u64.describe(
        'Raw amount of the coin being spent, taken from the wallet.',
      ),
      minOut: u64
        .optional()
        .describe(
          'Minimum output or the swap aborts. Defaults from a dry-run.',
        ),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe(
          'Tolerance off the dry-run when minOut is omitted (default 50 = 0.5%).',
        ),
    },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      const isBuy = args.side === 'buy'
      const amountIn = big(args.amountIn)
      let minOut = bigOpt(args.minOut)
      if (minOut === undefined) {
        const q = await client.coins.quote({
          ...pool,
          side: args.side,
          amountIn,
        })
        // Nothing would fill: leave it to the SDK, which refuses with its own
        // error instead of sending a swap with a zero floor.
        if (q.amountOut > 0n) {
          const bps = BigInt(args.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS)
          minOut = (q.amountOut * (10_000n - bps)) / 10_000n
        }
      }
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_swap',
          params: {
            ...poolParams(pool),
            side: args.side,
            amountIn: args.amountIn,
            minOut: minOut?.toString() ?? null,
          },
          worstCaseSpend: spend(
            isBuy ? pool.quoteCoinType : pool.baseCoinType,
            args.amountIn,
          ),
        },
        () =>
          client.coins.swap({
            ...pool,
            side: args.side,
            amountIn,
            ...(minOut !== undefined ? { minOut } : {}),
          }),
      )
    },
  },
  {
    name: 'prepare_coin_cancel_order',
    title: 'Prepare: cancel coin order',
    description:
      'Build a cancellation of one resting coin-pool order (id from coins_open_orders). Proceeds and refunds land in the pool’s settled balance — claim them with prepare_coin_claim_settled.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.cancel',
    inputShape: {
      ...senderShape,
      ...coinPoolSelectorShape,
      orderId: orderIdSchema,
    },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_cancel_order',
          params: { ...poolParams(pool), orderId: args.orderId },
        },
        () => client.coins.cancel({ ...pool, orderId: args.orderId }),
      )
    },
  },
  {
    name: 'prepare_coin_cancel_many_orders',
    title: 'Prepare: cancel several coin orders',
    description:
      'Build a cancellation of several resting orders in one coin pool. All or nothing: one unknown id aborts the batch — re-read coins_open_orders first.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.cancelMany',
    inputShape: {
      ...senderShape,
      ...coinPoolSelectorShape,
      orderIds: z
        .array(orderIdSchema)
        .min(1)
        .describe('Order ids (u128 decimal strings), all in this pool.'),
    },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_cancel_many_orders',
          params: { ...poolParams(pool), orderIds: args.orderIds },
        },
        () => client.coins.cancelMany({ ...pool, orderIds: args.orderIds }),
      )
    },
  },
  {
    name: 'prepare_coin_cancel_all_orders',
    title: 'Prepare: cancel all coin orders',
    description:
      'Build a cancellation of every order the sender’s trading account rests in one coin pool (a no-op on-chain when none rest).' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.cancelAll',
    inputShape: { ...senderShape, ...coinPoolSelectorShape },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      return prepared(
        ctx,
        args.sender,
        { action: 'coin_cancel_all_orders', params: poolParams(pool) },
        () => client.coins.cancelAll(pool),
      )
    },
  },
  {
    name: 'prepare_coin_modify_order',
    title: 'Prepare: resize coin order',
    description:
      'Build a resize of a resting coin-pool order. newQuantity is the new total: below the original and above the filled amount. The cut is refunded, with a bid’s maker-fee escrow on the same retention terms as a cancel.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.modify',
    inputShape: {
      ...senderShape,
      ...coinPoolSelectorShape,
      orderId: orderIdSchema,
      newQuantity: u64.describe('New total base quantity, raw units.'),
    },
    handler: async (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const pool = await resolvePool(client, args)
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_modify_order',
          params: {
            ...poolParams(pool),
            orderId: args.orderId,
            newQuantity: args.newQuantity,
          },
        },
        () =>
          client.coins.modify({
            ...pool,
            orderId: args.orderId,
            newQuantity: big(args.newQuantity),
          }),
      )
    },
  },
  {
    name: 'prepare_coin_claim_settled',
    title: 'Prepare: claim coin-pool proceeds',
    description:
      'Build a claim of settled balances (fills, cancels, refunds) from one or more coin pools into the trading account, in one transaction — optionally sweeping the listed coin types on to the wallet afterwards. coins_account shows what is settled per pool.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.claimSettled',
    inputShape: {
      ...senderShape,
      pools: z
        .array(z.object(coinPoolSelectorShape))
        .min(1)
        .describe(
          'Pools to settle from, each by poolId or baseCoinType (+ quoteCoinType).',
        ),
      withdrawCoinTypes: z
        .array(coinType)
        .optional()
        .describe(
          'Also withdraw these coin types’ whole account balance to the wallet.',
        ),
    },
    handler: (ctx, args) =>
      prepared(
        ctx,
        args.sender,
        {
          action: 'coin_claim_settled',
          params: {
            pools: args.pools,
            withdrawCoinTypes: args.withdrawCoinTypes ?? [],
          },
        },
        () =>
          ctx.writeClient(args.sender).coins.claimSettled({
            pools: args.pools.map(selectorOf),
            ...(args.withdrawCoinTypes
              ? { withdrawCoinTypes: args.withdrawCoinTypes }
              : {}),
          }),
      ),
  },
  {
    name: 'prepare_coin_create_pool',
    title: 'Prepare: open a coin market',
    description:
      'Build the permissionless creation of a coin pool for baseCoinType against quoteCoinType (default CRED, the approved permissionless quote). Costs the 500 CRED creation fee (500000000 base units) from the sender’s wallet. Both coins need an on-chain Currency registry entry, and their decimals may differ by at most 9. Aborts when the pair already exists — check coins_list first.' +
      PREPARE_SUFFIX,
    kind: 'prepare',
    sdkPath: 'coins.createPool',
    inputShape: {
      ...senderShape,
      baseCoinType: coinType.describe('Coin type the new pool trades.'),
      quoteCoinType: coinType
        .optional()
        .describe('Quote coin type; defaults to CRED.'),
    },
    handler: (ctx, args) => {
      const client = ctx.writeClient(args.sender)
      const cred = normalizeType(client.ids.credCoinType)
      return prepared(
        ctx,
        args.sender,
        {
          action: 'coin_create_pool',
          params: {
            baseCoinType: normalizeType(args.baseCoinType),
            quoteCoinType: args.quoteCoinType
              ? normalizeType(args.quoteCoinType)
              : cred,
          },
          worstCaseSpend: spend(cred, COIN_POOL_CREATION_FEE.toString()),
        },
        () =>
          client.coins.createPool({
            baseCoinType: args.baseCoinType,
            ...(args.quoteCoinType
              ? { quoteCoinType: args.quoteCoinType }
              : {}),
          }),
      )
    },
  },
]
