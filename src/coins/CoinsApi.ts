import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import type { TransactionObjectArgument } from '@mysten/sui/transactions'
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils'

import type { BookLevel } from '../book'
import { TriexClientError, TriexError } from '../errors'
import { executeAndNormalize, findCreatedObject } from '../execute'
import type { NormalizedExecution } from '../execute'
import { GTC_EXPIRE } from '../money'
import { getWalletCurrencyBalance } from '../onchain'
import type { IndexerClient } from '../queries'
import {
  generateProofAsOwner,
  withdrawAllCoin,
  withdrawCoin,
  depositCoin,
} from '../transactions'
import type { TriexClient } from '../TriexClient'
import type { PackageIds, TxResult } from '../types'
import { depositCoinDeficit, prepareCoinInput } from './funding'
import {
  COIN_MAX_FILLS,
  COIN_MAX_PRICE,
  COIN_MIN_PRICE,
  COIN_POOL_CREATION_FEE,
  coinMinOrderQuantity,
  computeCoinBidDeposit,
  conservativeBidFeeRate,
  estimateCoinMarketOrder,
} from './money'
import type { CoinMarketEstimate } from './money'
import {
  dryRunCoinQuantityOut,
  fetchCoinAccountOrders,
  fetchCoinBookSide,
  fetchCoinPoolAccount,
  fetchCoinPoolTypes,
  fetchCoinTradeParams,
  getTradingAccountCoinBalance,
  resolveCoinPoolId,
} from './onchain'
import type { CoinBookOrder, CoinPoolAccount, CoinTradeParams } from './onchain'
import {
  cancelAllCoinOrders,
  cancelCoinOrder,
  cancelCoinOrders,
  createPermissionlessCoinPool,
  modifyCoinOrder,
  placeCoinLimitOrder,
  placeCoinMarketOrder,
  swapExactBaseForQuote,
  swapExactQuoteForBase,
  withdrawSettledCoinAmounts,
  zeroCoin,
} from './transactions'
import type {
  CoinAccountParams,
  CoinBalances,
  CoinBalancesParams,
  CoinCancelOrderParams,
  CoinCancelOrdersParams,
  CoinClaimSettledParams,
  CoinDepositParams,
  CoinInfo,
  CoinLimitOrderParams,
  CoinMarketEstimateParams,
  CoinMarketOrderParams,
  CoinModifyOrderParams,
  CoinOrderbook,
  CoinOrderbookParams,
  CoinPool,
  CoinPoolSelector,
  CoinSwapParams,
  CoinSwapQuote,
  CoinSwapQuoteParams,
  CoinSwapResult,
  CoinTradeParamsParams,
  CoinWithdrawParams,
  CreateCoinPoolParams,
  CreateCoinPoolResult,
} from './types'

/** Max coin types per `/v1/coins` filter (the gateway 400s above it). */
const MAX_COIN_TYPES = 200

const MAX_U128 = (1n << 128n) - 1n

/** Default `coins.swap` slippage tolerance when `minOut` is omitted. */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50

/** What the coin read surface needs; supplied by both clients. */
export interface CoinsReadDeps {
  indexer: IndexerClient
  ids: PackageIds
  /** Fullnode client — every coin read except `list()` needs one. */
  suiClient?: ClientWithCoreApi
  /** Resolve the caller address; throws `AddressRequired` when unset. */
  requireAddress: (override?: string) => string
  /** Cached trading-account lookup (TriexClient); on-chain scan otherwise. */
  resolveTradingAccountId?: (address: string) => Promise<string | null>
  /** Sender for simulations touching an owned trading account. */
  defaultSender?: () => string | undefined
}

/**
 * Coin (currency-pair) market reads — shared by `TriexClient.coins` and
 * `ReadOnlyClient.coins`. `list()` is an indexer read; everything else reads
 * the chain through the fullnode (the coin-pool indexer routes are not on the
 * public gateway), so `ReadOnlyClient` needs a `suiClient` for those.
 *
 * Pools are addressed by a {@link CoinPoolSelector}: a `poolId`, or a
 * `baseCoinType` (+ `quoteCoinType`, default CRED). Resolutions are cached
 * for the life of the client — a pool's type never changes.
 *
 * ERRORS — `TriexClientError` with a stable `code`: `ValidationFailed` (bad
 * input, or no `suiClient` for a fullnode read), `PoolNotFound`,
 * `AddressRequired`, `UnexpectedResponse` (a simulation aborted), plus the
 * indexer codes on `list()`.
 */
export class CoinsReadApi {
  private readonly poolCache = new Map<string, CoinPool>()

  constructor(protected readonly deps: CoinsReadDeps) {}

  /** @internal */
  protected get ids(): PackageIds {
    return this.deps.ids
  }

  /** @internal */
  protected requireSui(): ClientWithCoreApi {
    if (!this.deps.suiClient) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Coin-pool reads come from the fullnode — configure a `suiClient` (ReadOnlyClient accepts one too).',
      )
    }
    return this.deps.suiClient
  }

  /**
   * Every coin in the token registry with supply facts and, when it has one,
   * its pool's market data (pooled coins first, most active first). Indexer
   * read — no fullnode needed.
   * @throws `ValidationFailed` for more than 200 coin types.
   */
  async list(params?: { coinTypes?: string[] }): Promise<CoinInfo[]> {
    if ((params?.coinTypes?.length ?? 0) > MAX_COIN_TYPES) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `At most ${MAX_COIN_TYPES} coin types per call.`,
      )
    }
    return this.deps.indexer.listCoins(params?.coinTypes)
  }

  /**
   * Resolve a selector to `{ poolId, baseCoinType, quoteCoinType }`: a pool id
   * is typed from its on-chain object; a coin pair is looked up in the
   * registry (`pool::get_pool_id_by_asset`). Cached per client.
   * @throws `ValidationFailed` when neither `poolId` nor `baseCoinType` is
   *   given, or a given type disagrees with the pool; `PoolNotFound`.
   */
  async resolvePool(selector: CoinPoolSelector): Promise<CoinPool> {
    const base = selector.baseCoinType
      ? normalizeType(selector.baseCoinType)
      : undefined
    const quote = normalizeType(selector.quoteCoinType ?? this.ids.credCoinType)

    if (selector.poolId) {
      const poolId = normalizeSuiAddress(selector.poolId)
      if (base && selector.quoteCoinType) {
        return { poolId, baseCoinType: base, quoteCoinType: quote }
      }
      let pool = this.poolCache.get(poolId)
      if (!pool) {
        pool = await fetchCoinPoolTypes(this.requireSui(), poolId)
        this.remember(pool)
      }
      if (
        (base && base !== pool.baseCoinType) ||
        (selector.quoteCoinType && quote !== pool.quoteCoinType)
      ) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          `Pool ${poolId} trades ${pool.baseCoinType}/${pool.quoteCoinType}, not the coin types given.`,
        )
      }
      return pool
    }

    if (!base) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Identify the coin pool by `poolId` or `baseCoinType` (+ `quoteCoinType`, default CRED).',
      )
    }
    const key = pairKey(base, quote)
    const cached = this.poolCache.get(key)
    if (cached) return cached
    const poolId = await resolveCoinPoolId(this.requireSui(), this.ids, {
      baseCoinType: base,
      quoteCoinType: quote,
    })
    if (!poolId) {
      throw new TriexClientError(
        TriexError.PoolNotFound,
        `No coin pool for ${base}/${quote}.`,
      )
    }
    const pool = { poolId, baseCoinType: base, quoteCoinType: quote }
    this.remember(pool)
    return pool
  }

  /**
   * The pool's resting book, both sides best-first (expired orders excluded),
   * read on-chain via `coin_order_query::iter_orders`, with price levels.
   */
  async orderbook(params: CoinOrderbookParams): Promise<CoinOrderbook> {
    const sui = this.requireSui()
    const pool = await this.resolvePool(params)
    const opts = { depth: params.depth ?? 100 }
    const [bids, asks] = await Promise.all([
      fetchCoinBookSide(sui, this.ids, pool, true, opts),
      fetchCoinBookSide(sui, this.ids, pool, false, opts),
    ])
    return {
      ...pool,
      bids: bids.orders,
      asks: asks.orders,
      bidLevels: levelsOf(bids.orders),
      askLevels: levelsOf(asks.orders),
      hasMoreBids: bids.hasMore,
      hasMoreAsks: asks.hasMore,
    }
  }

  /**
   * Fee state from the shared `FeePolicy`: entry-rung taker/maker rates, the
   * staged schedule, cancel retention, and — with `tradingAccountId` — that
   * account's tier, rates and trailing turnover.
   */
  async tradeParams(params: CoinTradeParamsParams): Promise<CoinTradeParams> {
    const sui = this.requireSui()
    const pool = await this.resolvePool(params)
    return fetchCoinTradeParams(
      sui,
      this.ids,
      pool,
      params.tradingAccountId ?? null,
      this.deps.defaultSender?.(),
    )
  }

  /**
   * Dry-run a swap (`pool::get_quantity_out_*`): what `amountIn` buys or sells
   * for against the live book, fees included. Entry-rung pricing unless a
   * `tradingAccountId` is given.
   * @throws `ValidationFailed` for a non-positive `amountIn`.
   */
  async quote(params: CoinSwapQuoteParams): Promise<CoinSwapQuote> {
    if (params.amountIn <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'amountIn must be positive.',
      )
    }
    const sui = this.requireSui()
    const pool = await this.resolvePool(params)
    const buy = params.side === 'buy'
    const [a, b] = await dryRunCoinQuantityOut(
      sui,
      this.ids,
      pool,
      {
        baseIn: buy ? 0n : params.amountIn,
        quoteIn: buy ? params.amountIn : 0n,
        tradingAccountId: params.tradingAccountId ?? null,
      },
      this.deps.defaultSender?.(),
    )
    // buy → (baseOut, quoteUnspent); sell → (baseUnspent, quoteOut)
    return buy
      ? { side: 'buy', amountIn: params.amountIn, amountOut: a, unspent: b }
      : { side: 'sell', amountIn: params.amountIn, amountOut: b, unspent: a }
  }

  /**
   * Price a market order of `quantity` base against the live book exactly as
   * matching will (`estimateCoinMarketOrder`). For a buy, `totalQuote` is the
   * quote the trading account must hold; for a sell, what it nets.
   */
  async estimateMarket(
    params: CoinMarketEstimateParams,
  ): Promise<CoinMarketEstimate> {
    if (params.quantity <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'quantity must be positive.',
      )
    }
    const sui = this.requireSui()
    const pool = await this.resolvePool(params)
    const isBuy = params.side === 'buy'
    const [side, rate] = await Promise.all([
      fetchCoinBookSide(sui, this.ids, pool, !isBuy, {
        depth: params.depth ?? COIN_MAX_FILLS,
      }),
      params.takerFeeRateScaled !== undefined
        ? Promise.resolve(params.takerFeeRateScaled)
        : fetchCoinTradeParams(sui, this.ids, pool).then((tp) =>
            conservativeBidFeeRate(tp.entry, tp.next, { marketOrder: true }),
          ),
    ])
    return estimateCoinMarketOrder(
      side.orders,
      params.side,
      params.quantity,
      rate,
    )
  }

  /**
   * A trading account's resting orders in this pool (empty when it has
   * none). `TriexClient` defaults to the player's own account.
   */
  async openOrders(params: CoinAccountParams): Promise<CoinBookOrder[]> {
    const sui = this.requireSui()
    const pool = await this.resolvePool(params)
    const accountId = await this.accountIdFor(params.tradingAccountId)
    if (!accountId) return []
    return fetchCoinAccountOrders(
      sui,
      this.ids,
      pool,
      accountId,
      this.deps.defaultSender?.(),
    )
  }

  /**
   * A trading account's state in this pool — open order ids, settled
   * (claimable) and owed balances, and what its open orders lock. Null when
   * it has never traded here (or has no trading account).
   */
  async account(params: CoinAccountParams): Promise<CoinPoolAccount | null> {
    const sui = this.requireSui()
    const pool = await this.resolvePool(params)
    const accountId = await this.accountIdFor(params.tradingAccountId)
    if (!accountId) return null
    return fetchCoinPoolAccount(
      sui,
      this.ids,
      pool,
      accountId,
      this.deps.defaultSender?.(),
    )
  }

  /**
   * Any coin's balances for a player: wallet coins + trading account
   * (fullnode, head-current) — the generic `balances.currency()`.
   * @throws `AddressRequired` when no address is configured or passed.
   */
  async balances(params: CoinBalancesParams): Promise<CoinBalances> {
    const sui = this.requireSui()
    const owner = this.deps.requireAddress(params.address)
    const coinType = normalizeType(params.coinType)
    const [wallet, tradingAccountId] = await Promise.all([
      getWalletCurrencyBalance(sui, owner, coinType),
      this.lookupAccount(owner),
    ])
    const tradingAccount = tradingAccountId
      ? await getTradingAccountCoinBalance(
          sui,
          this.ids,
          tradingAccountId,
          coinType,
        )
      : 0n
    return { coinType, wallet, tradingAccount, tradingAccountId }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** @internal */
  protected async lookupAccount(address: string): Promise<string | null> {
    if (this.deps.resolveTradingAccountId) {
      return this.deps.resolveTradingAccountId(address)
    }
    const page = await (this.requireSui() as any).core.listOwnedObjects({
      owner: address,
      type: `${this.ids.triexOriginal}::trading_account::TradingAccount`,
      limit: 1,
    })
    return page?.objects?.[0]?.objectId ?? null
  }

  /** @internal */
  protected async accountIdFor(explicit?: string): Promise<string | null> {
    if (explicit) return explicit
    return this.lookupAccount(this.deps.requireAddress())
  }

  private remember(pool: CoinPool): void {
    this.poolCache.set(pool.poolId, pool)
    this.poolCache.set(pairKey(pool.baseCoinType, pool.quoteCoinType), pool)
  }
}

/**
 * `client.coins` — coin (currency-pair) trading on `triex::pool` markets:
 * the {@link CoinsReadApi} reads plus writes signed by the client `executor`.
 *
 * Write flows mirror triex-app-api's `useTriexbookCoinOrders`: the trading
 * account is created inside the first order's PTB when missing, only the
 * deficit is pulled from the wallet (account balance first), and every order
 * is atomic — deposit + proof + place roll back together. Bid funding is
 * sized from the live `FeePolicy` so an order is never under-funded (see
 * `computeCoinBidDeposit`).
 */
export class CoinsApi extends CoinsReadApi {
  constructor(private readonly c: TriexClient) {
    super({
      indexer: c.indexer,
      ids: c.ids,
      suiClient: c.suiClient,
      requireAddress: (addr) => c.requireAddress(addr),
      resolveTradingAccountId: (addr) => c.resolveTradingAccountId(addr),
      defaultSender: () => {
        try {
          return c.requireAddress()
        } catch {
          return undefined
        }
      },
    })
  }

  /**
   * Deposit any coin from the wallet into the trading account (created in
   * the same PTB when missing). SUI is split from the gas coin.
   * @throws `ValidationFailed` (non-positive amount); `AddressRequired` |
   *   `ExecutorRequired`; `InsufficientBalance`; `TransactionFailed`.
   */
  async deposit(params: CoinDepositParams): Promise<TxResult> {
    if (params.amount <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Deposit amount must be positive.',
      )
    }
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const coinType = normalizeType(params.coinType)
    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)
    const coin = await prepareCoinInput(
      this.c.suiClient,
      tx,
      owner,
      coinType,
      params.amount,
    )
    depositCoin(tx, this.c.ids, bm, coin, coinType)
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * Withdraw any coin from the trading account to the wallet (default: all).
   * @throws `AddressRequired` | `ExecutorRequired`; `TradingAccountNotFound`;
   *   `TransactionFailed` (e.g. amount above the balance).
   */
  async withdraw(params: CoinWithdrawParams): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const accountId = await this.c.requireTradingAccountId(owner)
    const executor = this.c.requireExecutor()
    const coinType = normalizeType(params.coinType)
    const tx = new Transaction()
    const account = tx.object(accountId)
    const coin =
      params.amount !== undefined
        ? withdrawCoin(tx, this.c.ids, account, params.amount, coinType)
        : withdrawAllCoin(tx, this.c.ids, account, coinType)
    tx.transferObjects([coin], owner)
    return toTxResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Place a limit order, atomically: [create account] → deposit only the
   * deficit (base for asks; quote + fee for bids, sized at the conservative
   * entry-rung rate) → owner proof → `pool::place_limit_order`. GTC default.
   * @throws `ValidationFailed` (price outside [1, 2^63−1], quantity below
   *   `coinMinOrderQuantity(price)`); `AddressRequired` | `ExecutorRequired`;
   *   `PoolNotFound`; `InsufficientBalance`; `TransactionFailed` on-chain.
   */
  async limit(params: CoinLimitOrderParams): Promise<TxResult> {
    validateLimit(params.price, params.quantity)
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const pool = await this.resolvePool(params)
    const isBid = params.side === 'buy'

    let quoteDeposit = params.quoteDeposit
    if (isBid && quoteDeposit === undefined) {
      const tp = await fetchCoinTradeParams(this.c.suiClient, this.c.ids, pool)
      quoteDeposit = computeCoinBidDeposit(
        params.price,
        params.quantity,
        conservativeBidFeeRate(tp.entry, tp.next),
      )
    }
    if (isBid && (quoteDeposit === undefined || quoteDeposit <= 0n)) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Invalid quote deposit amount.',
      )
    }

    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)
    await depositCoinDeficit(
      this.c.suiClient,
      tx,
      this.c.ids,
      bm,
      existingBmId,
      owner,
      isBid ? pool.quoteCoinType : pool.baseCoinType,
      isBid ? (quoteDeposit as bigint) : params.quantity,
    )
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    placeCoinLimitOrder(tx, this.c.ids, {
      ...pool,
      account: bm,
      proof,
      price: params.price,
      quantity: params.quantity,
      isBid,
      orderType: params.orderType ?? 0,
      selfMatchingOption: params.selfMatchingOption ?? 0,
      expireTimestamp: params.expireAt ?? GTC_EXPIRE,
    })
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * Place a market order (IOC). Sells deposit the base deficit; buys hold
   * `quoteBudget`, defaulting to the exact cost against the live book.
   * Unfilled quantity is cancelled; unspent quote stays in the account.
   * @throws as `limit()`, plus `ValidationFailed` when a buy finds no asks.
   */
  async market(params: CoinMarketOrderParams): Promise<TxResult> {
    if (params.quantity <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Market orders need a positive quantity.',
      )
    }
    const owner = this.c.requireAddress()
    this.c.requireExecutor()
    const pool = await this.resolvePool(params)
    const isBid = params.side === 'buy'

    let target = params.quantity
    if (isBid) {
      if (params.quoteBudget !== undefined) {
        target = params.quoteBudget
      } else {
        const est = await this.estimateMarket({
          ...pool,
          side: 'buy',
          quantity: params.quantity,
        })
        if (est.filledQuantity === 0n) {
          throw new TriexClientError(
            TriexError.ValidationFailed,
            'The book has no asks a market buy could fill.',
          )
        }
        target = est.totalQuote
      }
      if (target <= 0n) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          'quoteBudget must be positive.',
        )
      }
    }

    const { tx, bm, existingBmId } = await this.c.beginBmTx(owner)
    await depositCoinDeficit(
      this.c.suiClient,
      tx,
      this.c.ids,
      bm,
      existingBmId,
      owner,
      isBid ? pool.quoteCoinType : pool.baseCoinType,
      target,
    )
    const proof = generateProofAsOwner(tx, this.c.ids, bm)[0]
    placeCoinMarketOrder(tx, this.c.ids, {
      ...pool,
      account: bm,
      proof,
      quantity: params.quantity,
      isBid,
      selfMatchingOption: params.selfMatchingOption ?? 0,
    })
    return this.c.finishBmTx(tx, bm, existingBmId, owner)
  }

  /**
   * Wallet-to-wallet swap — no trading account involved:
   * `swap_exact_quote_for_base` (buy) / `swap_exact_base_for_quote` (sell),
   * charged at the entry-rung taker rate. Output and any unabsorbed input
   * come back to the wallet. `minOut` defaults to the dry-run less
   * `slippageBps` (default 50).
   * @throws `ValidationFailed` (non-positive amount, or nothing would fill);
   *   `AddressRequired` | `ExecutorRequired`; `PoolNotFound`;
   *   `InsufficientBalance`; `TransactionFailed` (incl. min-out not met).
   */
  async swap(params: CoinSwapParams): Promise<CoinSwapResult> {
    if (params.amountIn <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'amountIn must be positive.',
      )
    }
    const owner = this.c.requireAddress()
    const executor = this.c.requireExecutor()
    const pool = await this.resolvePool(params)
    const isBuy = params.side === 'buy'

    let minOut = params.minOut
    if (minOut === undefined) {
      const q = await this.quote({
        ...pool,
        side: params.side,
        amountIn: params.amountIn,
      })
      if (q.amountOut === 0n) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          'Nothing would fill at the current book — no swap was sent.',
        )
      }
      const bps = BigInt(params.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS)
      if (bps < 0n || bps > 10_000n) {
        throw new TriexClientError(
          TriexError.ValidationFailed,
          'slippageBps must be within [0, 10000].',
        )
      }
      minOut = (q.amountOut * (10_000n - bps)) / 10_000n
    }

    const tx = new Transaction()
    const coinIn = await prepareCoinInput(
      this.c.suiClient,
      tx,
      owner,
      isBuy ? pool.quoteCoinType : pool.baseCoinType,
      params.amountIn,
    )
    const credIn = zeroCoin(tx, this.c.ids.credCoinType)
    const swapArgs = { ...pool, coinIn, credIn, minOut }
    const out = isBuy
      ? swapExactQuoteForBase(tx, this.c.ids, swapArgs)
      : swapExactBaseForQuote(tx, this.c.ids, swapArgs)
    tx.transferObjects([out[0], out[1], out[2]], owner)
    const res = await executeAndNormalize(executor, tx)
    return { ...toTxResult(res), minOut }
  }

  /**
   * Cancel one resting order (id from `openOrders()` / the book).
   * @throws `AddressRequired` | `ExecutorRequired`; `TradingAccountNotFound`;
   *   `PoolNotFound`; `ValidationFailed` (bad id); `TransactionFailed`.
   */
  async cancel(params: CoinCancelOrderParams): Promise<TxResult> {
    const orderId = parseOrderId(params.orderId)
    return this.withAccountTx(params, (tx, pool, account, proof) =>
      cancelCoinOrder(tx, this.c.ids, { ...pool, account, proof, orderId }),
    )
  }

  /**
   * Cancel several resting orders in one call (`pool::cancel_orders`) —
   * all-or-nothing: one unknown id aborts the batch.
   * @throws as `cancel()`, plus `ValidationFailed` for an empty list.
   */
  async cancelMany(params: CoinCancelOrdersParams): Promise<TxResult> {
    if (params.orderIds.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'orderIds must not be empty.',
      )
    }
    const orderIds = params.orderIds.map(parseOrderId)
    return this.withAccountTx(params, (tx, pool, account, proof) =>
      cancelCoinOrders(tx, this.c.ids, { ...pool, account, proof, orderIds }),
    )
  }

  /** Cancel every order the account rests in this pool (no-op when none). */
  async cancelAll(params: CoinPoolSelector): Promise<TxResult> {
    return this.withAccountTx(params, (tx, pool, account, proof) =>
      cancelAllCoinOrders(tx, this.c.ids, { ...pool, account, proof }),
    )
  }

  /**
   * Reduce a resting order's quantity (refunds the cut, maker-fee escrow on
   * the same retention terms as a cancel).
   * @throws as `cancel()`, plus `ValidationFailed` (non-positive quantity).
   */
  async modify(params: CoinModifyOrderParams): Promise<TxResult> {
    if (params.newQuantity <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Modified quantity must be positive.',
      )
    }
    const orderId = parseOrderId(params.orderId)
    return this.withAccountTx(params, (tx, pool, account, proof) =>
      modifyCoinOrder(tx, this.c.ids, {
        ...pool,
        account,
        proof,
        orderId,
        newQuantity: params.newQuantity,
      }),
    )
  }

  /**
   * Move settled balances (fills, cancels, refunds) from one or more pools
   * into the trading account in one PTB — optionally sweeping coin types on
   * to the wallet afterwards.
   * @throws `ValidationFailed` for no pools; `AddressRequired` |
   *   `ExecutorRequired`; `TradingAccountNotFound`; `PoolNotFound`;
   *   `TransactionFailed`.
   */
  async claimSettled(params: CoinClaimSettledParams): Promise<TxResult> {
    if (params.pools.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Pass at least one pool to claim from.',
      )
    }
    const owner = this.c.requireAddress()
    const accountId = await this.c.requireTradingAccountId(owner)
    const executor = this.c.requireExecutor()
    const pools = await Promise.all(
      params.pools.map((p) => this.resolvePool(p)),
    )

    const tx = new Transaction()
    const account = tx.object(accountId)
    const proof = generateProofAsOwner(tx, this.c.ids, account)[0]
    for (const pool of pools) {
      withdrawSettledCoinAmounts(tx, this.c.ids, { ...pool, account, proof })
    }
    for (const coinType of params.withdrawCoinTypes ?? []) {
      const coin = withdrawAllCoin(
        tx,
        this.c.ids,
        account,
        normalizeType(coinType),
      )
      tx.transferObjects([coin], owner)
    }
    return toTxResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Create a coin pool permissionlessly, paying the 500-CRED creation fee
   * from the wallet. Both coins need a `coin_registry::Currency` object.
   * @throws `AddressRequired` | `ExecutorRequired`; `InsufficientBalance`;
   *   `TransactionFailed` (pair exists, quote not approved, decimal gap > 9).
   */
  async createPool(
    params: CreateCoinPoolParams,
  ): Promise<CreateCoinPoolResult> {
    const owner = this.c.requireAddress()
    const executor = this.c.requireExecutor()
    const baseCoinType = normalizeType(params.baseCoinType)
    const quoteCoinType = normalizeType(
      params.quoteCoinType ?? this.c.ids.credCoinType,
    )
    const tx = new Transaction()
    const fee = await prepareCoinInput(
      this.c.suiClient,
      tx,
      owner,
      this.c.ids.credCoinType,
      COIN_POOL_CREATION_FEE,
      'Insufficient CRED for the 500 CRED pool creation fee.',
    )
    createPermissionlessCoinPool(tx, this.c.ids, {
      baseCoinType,
      quoteCoinType,
      creationFee: fee,
    })
    const res = await executeAndNormalize(executor, tx)
    return {
      ...toTxResult(res),
      poolId: findCreatedObject(res, '::pool::Pool<')?.objectId ?? null,
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Cancels/modifies/claims need an EXISTING account and a resolved pool. */
  private async withAccountTx(
    selector: CoinPoolSelector,
    build: (
      tx: Transaction,
      pool: CoinPool,
      account: TransactionObjectArgument,
      proof: TransactionObjectArgument,
    ) => void,
  ): Promise<TxResult> {
    const owner = this.c.requireAddress()
    const accountId = await this.c.requireTradingAccountId(owner)
    const executor = this.c.requireExecutor()
    const pool = await this.resolvePool(selector)
    const tx = new Transaction()
    const account = tx.object(accountId)
    const proof = generateProofAsOwner(tx, this.c.ids, account)[0]
    build(tx, pool, account, proof)
    return toTxResult(await executeAndNormalize(executor, tx))
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toTxResult(res: NormalizedExecution): TxResult {
  return {
    digest: res.digest,
    createdObjects: res.createdObjects,
    raw: res.raw,
  }
}

function normalizeType(coinType: string): string {
  try {
    return normalizeStructTag(coinType.trim())
  } catch {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Invalid coin type "${coinType}" — expected 0x…::module::NAME.`,
    )
  }
}

const pairKey = (base: string, quote: string) => `${base}|${quote}`

/** Collapse best-first orders into price levels (book order preserved). */
function levelsOf(orders: CoinBookOrder[]): BookLevel[] {
  const levels: BookLevel[] = []
  for (const o of orders) {
    const last = levels[levels.length - 1]
    if (last && last.price === o.price) {
      last.quantity += o.remainingQuantity
      last.orderCount++
    } else {
      levels.push({
        price: o.price,
        quantity: o.remainingQuantity,
        orderCount: 1,
      })
    }
  }
  return levels
}

function validateLimit(price: bigint, quantity: bigint): void {
  if (price < COIN_MIN_PRICE || price > COIN_MAX_PRICE) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Price ${price} is outside the valid range [${COIN_MIN_PRICE}, ${COIN_MAX_PRICE}] (raw, 1e9-scaled).`,
    )
  }
  const min = coinMinOrderQuantity(price)
  if (quantity < min) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Quantity ${quantity} is below the minimum ${min} for price ${price} — the order would convert to zero quote (EOrderBelowMinimumSize).`,
    )
  }
}

/** Order ids are Move `u128`: bigint, decimal, or 0x-hex string. */
function parseOrderId(orderId: bigint | string): bigint {
  const text = typeof orderId === 'string' ? orderId.trim() : null
  const id =
    text === null
      ? (orderId as bigint)
      : /^(\d+|0x[0-9a-fA-F]+)$/.test(text)
        ? BigInt(text)
        : -1n
  if (id < 0n || id > MAX_U128) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Invalid order id ${String(orderId)}: expected a u128 integer.`,
    )
  }
  return id
}
