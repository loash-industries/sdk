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
  HubItemSchema,
  HubItemsPageSchema,
  HubLocationSchema,
  HubVaultSchema,
  InventoryBalancesSchema,
  OpenOrderSchema,
  OpenOrdersPageSchema,
  OrderbookOrderSchema,
  PoolMetadataSchema,
  TradeSchema,
  TradesPageSchema,
} from './schemas'

// ─── Wallet / executor plumbing (mirrors keyspace) ──────────────────────────

/** A single object change returned by an executed transaction. */
export interface ObjectChange {
  type: string
  objectId?: string
  objectType?: string
  [key: string]: unknown
}

/** Result of signing + executing a PTB. */
export interface ExecuteResult {
  digest: string
  objectChanges?: ObjectChange[]
  [key: string]: unknown
}

/**
 * Signs and submits a PTB. Delegated to the caller's wallet (browser) or a
 * keypair (bot). Must be configured with `showObjectChanges: true` so the SDK
 * can extract newly-created object IDs (e.g. a freshly-created balance manager).
 */
export type TransactionExecutor = (tx: Transaction) => Promise<ExecuteResult>

/** Convenience shape returned by every mutating SDK method. */
export interface TxResult {
  digest: string
  objectChanges?: ObjectChange[]
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
  /** triexbook package: balance_manager + multicoin_pool. */
  triexbook: string
  /** triexbook registry (shared object). */
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

/** Order book for one pool: resting orders (not aggregated price levels). */
export interface Orderbook {
  poolId: string
  /** Bids, highest first. */
  bids: OrderbookOrder[]
  /** Asks, lowest first. */
  asks: OrderbookOrder[]
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
  characterId: string
  items: { assetId: string; amount: bigint }[]
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
}

export interface MarketOrderParams {
  storageUnitId: string
  assetId: string
  side: OrderSide
  quantity: bigint
  /** Required for market buys — the max CRED (base units) to spend. */
  quoteBudget?: bigint
}
