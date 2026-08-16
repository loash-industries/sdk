import type { Transaction } from '@mysten/sui/transactions'
// `ClientWithCoreApi` is the modern SuiClient interface (what `new SuiClient()`
// satisfies); `@mysten/sui` v2 no longer type-exports a `SuiClient` name.
import type { ClientWithCoreApi } from '@mysten/sui/client'

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
  suiClient?: ClientWithCoreApi
  apiKey: string
  indexerUrl?: string
  network?: TriexNetwork
  packageIds?: Partial<PackageIds>
}

// ─── Domain types (shapes are provisional — tighten in Phase 1, see RQ-1) ────

export type OrderSide = 'buy' | 'sell'

/** The player's on-chain trading account. */
export interface TradingAccount {
  balanceManagerId: string
  owner: string
}

/** An item + currency balance snapshot for a character. */
export interface CharacterBalances {
  characterId: string
  address: string
  /** CRED balance in the player's wallet (base units). */
  walletCurrency: bigint
  /** CRED balance held inside the balance manager (base units). */
  balanceManagerCurrency: bigint
  /** Per-item balances across wallet/hangar and the balance manager. */
  items: ItemBalance[]
  balanceManagerId?: string
}

export interface ItemBalance {
  typeId: string
  /** Quantity held in wallet receipts + hangar. */
  ownedQuantity: bigint
  /** Quantity held inside the balance manager. */
  balanceManagerQuantity: bigint
}

/** Trade-hub (SSU) details — public/private, ownership, fuel, vault. */
export interface TradeHubDetail {
  hubId: string
  collectionId?: string
  isPublic: boolean
  ownerAddress?: string
  ownerCharacterId?: string
  ownerTribeId?: string
  fuel?: { current: bigint; capacity: bigint; isOnline: boolean }
  location?: { solarSystemId?: string; name?: string }
}

/** One item that has live orders at a hub. */
export interface HubItemListing {
  typeId: string
  poolId: string
  bestBid?: bigint
  bestAsk?: bigint
  bidDepth?: bigint
  askDepth?: bigint
}

export interface OrderbookLevel {
  price: bigint
  quantity: bigint
}

export interface Orderbook {
  poolId: string
  bids: OrderbookLevel[]
  asks: OrderbookLevel[]
}

export interface PoolMetadata {
  poolId: string
  baseCollectionId: string
  assetId: string
  quoteCoinType: string
  feeBps: number
  /** SDK assumes v1 always; carried for completeness. */
  version: number
}

/** A single open order across the universe (from `/v1/discovery`). */
export interface DiscoveryOrder {
  poolId: string
  hubId: string
  typeId: string
  side: OrderSide
  price: bigint
  quantity: bigint
  /** Epoch milliseconds. */
  createdAt: number
}

export interface DiscoveryResult {
  orders: DiscoveryOrder[]
  nextCursor?: string
}

export interface OpenOrder {
  orderId: string
  poolId: string
  side: OrderSide
  price: bigint
  quantity: bigint
  filled: bigint
  /** Epoch milliseconds. */
  expireAt?: number
}

export interface Fill {
  orderId: string
  poolId: string
  side: OrderSide
  price: bigint
  quantity: bigint
  /** Epoch milliseconds. */
  timestamp: number
}

export interface Trade extends Fill {
  counterparty?: string
}

// ─── Method params ──────────────────────────────────────────────────────────

export interface EnsureAccountResult {
  balanceManagerId: string
  created: boolean
}

export interface DepositCurrencyParams {
  amount: bigint
}

export interface DepositItemsParams {
  storageUnitId: string
  items: { typeId: string; amount: bigint }[]
}

export interface WithdrawCurrencyParams {
  /** Omit to withdraw the full balance. */
  amount?: bigint
}

export interface WithdrawItemsParams {
  storageUnitId: string
  characterId: string
  items: { typeId: string; amount: bigint }[]
}

export interface LimitOrderParams {
  storageUnitId: string
  typeId: string
  side: OrderSide
  /** Price in quote (CRED) base units per item, pre-scaling. */
  price: bigint
  quantity: bigint
  /** Epoch milliseconds; defaults to a far-future timestamp. */
  expireAt?: number
}

export interface MarketOrderParams {
  storageUnitId: string
  typeId: string
  side: OrderSide
  quantity: bigint
  /** Required for market buys — the max CRED (base units) to spend. */
  quoteBudget?: bigint
}
