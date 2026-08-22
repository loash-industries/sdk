import type { Transaction } from '@mysten/sui/transactions'
// `ClientWithCoreApi` is the modern SuiClient interface (what `new SuiClient()`
// satisfies); `@mysten/sui` v2 no longer type-exports a `SuiClient` name.
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { z } from 'zod'
import type {
  AssetBalanceSchema,
  CollectionHubSchema,
  DiscoveryOrderSchema,
  DiscoveryResultSchema,
  FillSchema,
  FillsPageSchema,
  HubItemOrderbookSchema,
  HubItemSchema,
  HubItemsPageSchema,
  HubLocationSchema,
  HubVaultSchema,
  InventoryBalancesSchema,
  OpenOrderSchema,
  OpenOrdersPageSchema,
  OrderbookOrderSchema,
  PoolMetadataSchema,
  SweepableItemSchema,
  SweepablePoolSchema,
  SweepableSchema,
  TradeSchema,
  TradesPageSchema,
} from './schemas'

// ─── Wallet / executor plumbing (mirrors keyspace) ──────────────────────────

/** A single object change returned by a legacy-shaped executed transaction. */
export interface ObjectChange {
  type: string
  objectId?: string
  objectType?: string
  [key: string]: unknown
}

/**
 * Signs and submits a PTB. Delegated to the caller's wallet (browser) or a
 * keypair (bot). Return the execution result as-is — the SDK normalizes both
 * the v2 core-client `TransactionResult` (`signAndExecuteTransaction({
 * transaction, signer, include: { effects: true, objectTypes: true } })`) and
 * legacy `{ digest, objectChanges }` shapes, and surfaces on-chain failures
 * as typed `TransactionFailed` errors. Include effects/objectTypes (v2) or
 * objectChanges (legacy) so the SDK can capture created object ids.
 */
export type TransactionExecutor = (tx: Transaction) => Promise<unknown>

/** Convenience shape returned by every mutating SDK method. */
export interface TxResult {
  digest: string
  /** Objects created by the transaction, when the executor surfaced them. */
  createdObjects: { objectId: string; objectType: string }[]
  /** The executor's untouched return value. */
  raw: unknown
}

// ─── Networks & on-chain IDs ─────────────────────────────────────────────────

/** Only testnet (the `stillness` world) is supported for now. */
export type TriexNetwork = 'testnet'

/**
 * On-chain package / object IDs the SDK needs. Baked per-network in `config.ts`
 * (source of truth: the `stillness` tenant in triex-app-api); each field is
 * overridable via {@link TriexClientConfig.packageIds}.
 */
export interface PackageIds {
  /**
   * Triex CLOB package: balance_manager + multicoin_pool. See the Move
   * contracts at https://github.com/loash-industries/trinary-exchange.
   */
  triex: string
  /** Triex CLOB registry (shared object). */
  triexRegistry: string
  /** multicoin package (defines the item `Balance` struct type). */
  multicoin: string
  /** warehouse_receipts package (`receipt::redeem_receipt` / `deposit_for_receipt`). */
  warehouseReceipts: string
  /** The CRED trade-currency coin type (`0x…::cred::CRED`). */
  credCoinType: string
  /** World package (character owner-cap borrow/return). */
  world: string
  /** Original world package id (used for owner-cap type args). */
  worldOriginal: string
  /** The Sui `Clock` shared object — always `0x6`. */
  clock: string
}

// ─── Client config ──────────────────────────────────────────────────────────

export interface TriexClientConfig {
  /** @mysten/sui SuiClient (fullnode reads + PTB input resolution). */
  suiClient: ClientWithCoreApi
  /** API key sent as `x-api-key` on all indexer reads. */
  apiKey: string
  /** Signs + submits PTBs. Required for any write; omit for read-only use. */
  executor?: TransactionExecutor
  /**
   * The player's Sui address (the signer behind `executor`). Required for write
   * flows that transfer created objects / coins back to the owner. For browser
   * wallets that expose the address dynamically, pass it per-call instead.
   */
  address?: string
  /** Indexer base URL. Defaults to `https://api.trinary.exchange`. */
  indexerUrl?: string
  /** Network preset selector. Defaults to `testnet`. */
  network?: TriexNetwork
  /** Per-field overrides of the network's baked-in package IDs. */
  packageIds?: Partial<PackageIds>
}

export interface ReadOnlyClientConfig {
  apiKey: string
  indexerUrl?: string
  network?: TriexNetwork
  packageIds?: Partial<PackageIds>
}

// ─── Domain types (inferred from the pinned wire schemas — see schemas.ts) ───

export type OrderSide = 'buy' | 'sell'

export type DiscoveryOrder = z.output<typeof DiscoveryOrderSchema>
export type DiscoveryResult = z.output<typeof DiscoveryResultSchema>
export type OrderbookOrder = z.output<typeof OrderbookOrderSchema>
export type PoolMetadata = z.output<typeof PoolMetadataSchema>
export type HubVaultInfo = z.output<typeof HubVaultSchema>
export type HubLocation = z.output<typeof HubLocationSchema>
export type HubItem = z.output<typeof HubItemSchema>
export type HubItemsPage = z.output<typeof HubItemsPageSchema>
export type CollectionHub = z.output<typeof CollectionHubSchema>
export type AssetBalance = z.output<typeof AssetBalanceSchema>
export type InventoryBalances = z.output<typeof InventoryBalancesSchema>
export type OpenOrder = z.output<typeof OpenOrderSchema>
export type OpenOrdersPage = z.output<typeof OpenOrdersPageSchema>
export type Fill = z.output<typeof FillSchema>
export type FillsPage = z.output<typeof FillsPageSchema>
export type Trade = z.output<typeof TradeSchema>
export type TradesPage = z.output<typeof TradesPageSchema>
export type SweepablePool = z.output<typeof SweepablePoolSchema>
export type SweepableItem = z.output<typeof SweepableItemSchema>
export type Sweepable = z.output<typeof SweepableSchema>

/** Order book for one pool: resting orders (not aggregated price levels). */
export interface Orderbook {
  poolId: string
  /** Bids, highest first. */
  bids: OrderbookOrder[]
  /** Asks, lowest first. */
  asks: OrderbookOrder[]
}

/**
 * Wire result of the one-call hub-item market read (`poolId` null when the
 * hub trades but no market exists for the item yet).
 */
export type HubItemMarket = z.output<typeof HubItemOrderbookSchema>

/**
 * Order book for one item at a trade hub, with the hub/pool context the
 * single-call endpoint returns alongside the resting orders.
 */
export interface HubItemOrderbook extends Orderbook {
  hubId: string
  /** Item collection backing the hub's vault (PTB input, §6.1). */
  collectionId: string
  /** The hub vault's configuration object; null when not yet indexed. */
  vaultConfigId: string | null
  /** Pool metadata (decimals, fee rate, names); null if the indexer lacks it. */
  metadata: PoolMetadata | null
}

/** Trade-hub detail — the vault descriptor + indexed location/ownership. */
export interface TradeHubDetail {
  hubId: string
  /** Item collection backing the hub's vault (PTB input, §6.1). */
  collectionId: string
  /** The hub vault's configuration object (PTB input, §6.1). */
  vaultConfigId: string
  /**
   * Location / ownership / visibility — null when the hub's location is not
   * revealed (etl-api 404s those; most hubs are private).
   */
  location: HubLocation | null
}

/** The player's on-chain trading account. */
export interface TradingAccount {
  balanceManagerId: string
  owner: string
}

/**
 * CRED balances for a player — read from the FULLNODE (head-current), because
 * the indexer's inventory endpoint serves item balances only.
 */
export interface CurrencyBalances {
  /** CRED held as wallet coins (base units). */
  wallet: bigint
  /** CRED held inside the balance manager (base units); 0n when no BM. */
  balanceManager: bigint
  /** Resolved balance manager, when one exists. */
  balanceManagerId: string | null
}

// ─── Method params ──────────────────────────────────────────────────────────

export interface EnsureAccountResult {
  balanceManagerId: string
  created: boolean
}

export interface DiscoveryFilters {
  /** Comma-joined server-side; trade hub IDs and/or item collection IDs (max 100). */
  storageUnitIds?: string[]
  /** Numeric item type / asset id. */
  assetId?: string
  /** Only orders owned by this balance manager ("my orders"). */
  balanceManagerId?: string
  /** Default `both`. */
  side?: 'buy' | 'sell' | 'both'
  /** Restrict to location-revealed (public) hubs. */
  publicOnly?: boolean
  cursor?: string
  /** Rows per page (default and max 100). */
  limit?: number
}

export interface BalancesAtHubParams {
  /** Trade hub scoping the whole read (the collection derives from it). */
  storageUnitId: string
  /** Wallet whose warehouse (receipt) balances to include. */
  address?: string
  /**
   * Hub or character `owner_cap_id` selecting a hangar to include. Resolved
   * on-chain by the caller for now (Phase 2 adds automatic resolution).
   */
  inventoryKey?: string
  /** Organization (DAO) receipt vault ids to include. */
  vaultIds?: string[]
}

/** Cursorless history paging: epoch-ms bounds + limit (1–100). */
export interface HistoryPageParams {
  before?: number
  after?: number
  limit?: number
}

export interface FillsParams extends HistoryPageParams {
  poolId?: string
  /** The account's role in the fill. */
  side?: 'maker' | 'taker' | 'all'
}

export interface TradesParams extends HistoryPageParams {
  /** The account's role in the trade. */
  side?: 'maker' | 'taker' | 'all'
  assetId?: string
}

export interface DepositCurrencyParams {
  amount: bigint
}

export interface DepositItemsParams {
  storageUnitId: string
  items: { assetId: string; amount: bigint }[]
}

export interface WithdrawCurrencyParams {
  /** Omit to withdraw the full balance. */
  amount?: bigint
}

export interface WithdrawItemsParams {
  storageUnitId: string
  /**
   * Each listed asset is withdrawn IN FULL (`withdraw_all_multicoin`) and
   * redeemed into the hangar at the hub — partial item withdrawal is not part
   * of the redeem flow (matches the app's sweep semantics).
   */
  items: { assetId: string }[]
  /** Defaults to the on-chain character resolved from the client address. */
  characterId?: string
}

export interface LimitOrderParams {
  storageUnitId: string
  assetId: string
  side: OrderSide
  /** Price in quote (CRED) base units per item (multicoin scaling = 1). */
  price: bigint
  quantity: bigint
  /** Epoch milliseconds; defaults to good-til-cancelled (MAX_U64). */
  expireAt?: bigint
  /** 0 = none (default), 1 = IOC, 2 = FOK, 3 = POST_ONLY. */
  orderType?: number
  /** 0 = allowed (default), 1 = cancel taker, 2 = cancel maker. */
  selfMatchingOption?: number
  /**
   * Override the quote (CRED) amount deposited for a bid; defaults to
   * `computeBidQuoteDeposit(price, quantity, feeRateScaled)`.
   */
  quoteDeposit?: bigint
}

export interface MarketOrderParams {
  storageUnitId: string
  assetId: string
  side: OrderSide
  quantity: bigint
  /**
   * Required for market buys — worst-case CRED cost including taker fees,
   * typically `estimateMarketBuyCost(book.asks, quantity, feeRateScaled)`.
   * The SDK adds the app's per-fill rounding buffer on top.
   */
  quoteBudget?: bigint
  /** 0 = allowed (default), 1 = cancel taker, 2 = cancel maker. */
  selfMatchingOption?: number
}

export interface CancelOrderParams {
  storageUnitId: string
  assetId: string
  /** Pool-local order id (u64), from `orders.openOrders()` / discovery. */
  orderId: bigint | string
}

export interface CancelAllOrdersParams {
  storageUnitId: string
  assetId: string
}

export interface ModifyOrderParams extends CancelOrderParams {
  /** New quantity — must be less than original and more than filled. */
  newQuantity: bigint
}

export interface ClaimSettledParams {
  /** Pools to claim from; defaults to every pool the sweepable read reports. */
  poolIds?: string[]
}
