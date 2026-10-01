import type { Transaction } from '@mysten/sui/transactions'
// `ClientWithCoreApi` is the modern SuiClient interface (what `new SuiClient()`
// satisfies); `@mysten/sui` v2 no longer type-exports a `SuiClient` name.
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { z } from 'zod'
import type { OwnedTradingAccountCap } from './onchain'
import type { TradingAccountCapKind } from './transactions'
import type {
  AssemblyEnrichedSchema,
  AssemblyOwnerSchema,
  AssetBalanceSchema,
  AutocompleteSystemsSchema,
  TradingAccountOwnerSchema,
  BatchSystemsSchema,
  CoordinateSearchSchema,
  CoordinatesSchema,
  CollectionHubSchema,
  DiscoveryOrderSchema,
  DiscoveryResultSchema,
  FillSchema,
  FillsPageSchema,
  HubItemOrderbookSchema,
  HubItemSchema,
  HubEnrichedSchema,
  HubItemsPageSchema,
  HubLocationPageSchema,
  HubLocationSchema,
  ItemRecipeComponentSchema,
  ItemRecipeSchema,
  ItemSearchPageSchema,
  ItemSearchResultSchema,
  HubVaultSchema,
  InventoryBalancesSchema,
  OpenOrderSchema,
  OpenOrdersPageSchema,
  NearbyHubSchema,
  NearbySystemSchema,
  NearbySystemsSchema,
  OrderbookOrderSchema,
  PoolMetadataSchema,
  SolarSystemNameSchema,
  SolarSystemSchema,
  SolarSystemSuggestionSchema,
  SpatialStatsSchema,
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
   * Triex CLOB package: trading_account + multicoin_pool. See the Move
   * contracts at https://github.com/loash-industries/trinary-exchange.
   */
  triex: string
  /**
   * The triex package's ORIGINAL id. Struct types (`TradingAccount`, cap and
   * balance-key types) keep the id of the version that defined them, so type
   * filters and dynamic-field key types use this; `moveCall` targets use
   * {@link PackageIds.triex}. Equal to `triex` until the first upgrade.
   */
  triexOriginal: string
  /** Triex CLOB registry (shared object). */
  triexRegistry: string
  /**
   * Triex `fee_policy::FeePolicy` (shared object). Order placement, cancel,
   * cancel-all and modify on a `MultiCoinPool` take it by reference.
   */
  triexFeePolicy: string
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

  // ─── Armature (organizations & governance) — DESIGN-ARMATURE.md §9 ────────
  //
  // Each upgraded package carries a `*Original` sibling. `moveCall` targets use
  // the CURRENT id; dynamic-field key types and `StructType` filters must use
  // the ORIGINAL, because objects keep the type tag of the package version that
  // created them. Cycle 7 fresh-published every package, so on `stillness` each
  // pair is currently equal — they diverge again on the first upgrade.

  /** armature_framework: ou, board_voting, proposal, composite, treasury_vault, controller. */
  armature: string
  armatureOriginal: string
  /** armature_proposals: the governance payload types and their `execute_*` dispatchers. */
  armatureProposals: string
  armatureProposalsOriginal: string
  /** armature_trading: governance-wrapped CLOB operations. */
  armatureTrading: string
  armatureTradingOriginal: string
  /** armature_vault: `ou_receipt_vault` (shared storage) + `acl` principals. */
  armatureVault: string
  armatureVaultOriginal: string
  /** `ou_receipt_vault::OuReceiptVaultRegistry` shared object (not a package). */
  ouReceiptVaultRegistry: string
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
  /**
   * Optional fullnode client. Only `coins.*` reads use it (coin-pool books,
   * orders and fees are on-chain reads); everything else stays indexer-only.
   */
  suiClient?: ClientWithCoreApi
}

// ─── Domain types (inferred from the pinned wire schemas — see schemas.ts) ───

export type OrderSide = 'buy' | 'sell'

export type DiscoveryOrder = z.output<typeof DiscoveryOrderSchema>
export type DiscoveryResult = z.output<typeof DiscoveryResultSchema>
export type OrderbookOrder = z.output<typeof OrderbookOrderSchema>
export type PoolMetadata = z.output<typeof PoolMetadataSchema>
export type HubVaultInfo = z.output<typeof HubVaultSchema>
export type HubLocation = z.output<typeof HubLocationSchema>
export type HubLocationPage = z.output<typeof HubLocationPageSchema>
export type NearbyHub = z.output<typeof NearbyHubSchema>
export type HubEnriched = z.output<typeof HubEnrichedSchema>
export type AssemblyOwner = z.output<typeof AssemblyOwnerSchema>
export type AssemblyEnriched = z.output<typeof AssemblyEnrichedSchema>
export type TradingAccountOwner = z.output<typeof TradingAccountOwnerSchema>
export type SolarSystemName = z.output<typeof SolarSystemNameSchema>
export type Coordinates = z.output<typeof CoordinatesSchema>
export type SolarSystem = z.output<typeof SolarSystemSchema>
export type NearbySystem = z.output<typeof NearbySystemSchema>
export type BatchSystems = z.output<typeof BatchSystemsSchema>
export type NearbySystems = z.output<typeof NearbySystemsSchema>
export type CoordinateSearch = z.output<typeof CoordinateSearchSchema>
export type SolarSystemSuggestion = z.output<typeof SolarSystemSuggestionSchema>
export type AutocompleteSystems = z.output<typeof AutocompleteSystemsSchema>
export type SpatialStats = z.output<typeof SpatialStatsSchema>
export type HubItem = z.output<typeof HubItemSchema>
export type HubItemsPage = z.output<typeof HubItemsPageSchema>
export type CollectionHub = z.output<typeof CollectionHubSchema>
export type ItemRecipeComponent = z.output<typeof ItemRecipeComponentSchema>
export type ItemRecipe = z.output<typeof ItemRecipeSchema>
export type ItemSearchResult = z.output<typeof ItemSearchResultSchema>
export type ItemSearchPage = z.output<typeof ItemSearchPageSchema>
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
  tradingAccountId: string
  owner: string
}

/**
 * CRED balances for a player — read from the FULLNODE (head-current), because
 * the indexer's inventory endpoint serves item balances only.
 */
export interface CurrencyBalances {
  /** CRED held as wallet coins (base units). */
  wallet: bigint
  /** CRED held inside the trading account (base units); 0n when no BM. */
  tradingAccount: bigint
  /** Resolved trading account, when one exists. */
  tradingAccountId: string | null
}

// ─── Method params ──────────────────────────────────────────────────────────

export interface EnsureAccountResult {
  tradingAccountId: string
  created: boolean
}

export interface DiscoveryFilters {
  /** Comma-joined server-side; trade hub IDs and/or item collection IDs (max 100). */
  storageUnitIds?: string[]
  /** Numeric item type / asset id. */
  assetId?: string
  /** Only orders owned by this trading account ("my orders"). */
  tradingAccountId?: string
  /** Default `both`. */
  side?: 'buy' | 'sell' | 'both'
  /** Restrict to location-revealed (public) hubs. */
  publicOnly?: boolean
  cursor?: string
  /** Rows per page (default and max 100). */
  limit?: number
}

/**
 * A batch solar-system lookup takes ids OR names — never both, and never
 * neither. Modelled as a union so the compiler rejects the mistake the
 * gateway would answer with a 400.
 */
export type BatchSystemsParams =
  | { solarSystemIds: number[]; solarSystemNames?: never }
  | { solarSystemNames: string[]; solarSystemIds?: never }

/** Radius search around a named or numbered solar system. */
export interface NearbySystemsParams {
  /** Solar system name (case-insensitive) or numeric id. */
  solarSystem: string
  /** Search radius in light years (positive, max 10,000). */
  radiusLy: number
  /** Systems to return, nearest first (default 100, max 1,000). */
  limit?: number
}

/**
 * Radius search around an arbitrary point — for origins that are not
 * themselves a solar system, such as a ship or structure position read from
 * the chain.
 */
export interface CoordinateSearchParams {
  /** Origin coordinates in METRES, as decimal strings (they exceed 2^53). */
  x: string
  y: string
  z: string
  /** Search radius in light years (positive, max 10,000). */
  radiusLy: number
  /** Systems to return, nearest first (default 100, max 1,000). */
  limit?: number
}

/** Filters for the universe-wide hub location listing. */
export interface HubLocationFilters {
  /** Numeric solar system id to restrict to. */
  solarSystemId?: number
  /** Tenant (shard) to restrict to. */
  tenant?: string
  /** Only hubs that have trading initialised (a vault exists). */
  hasVault?: boolean
  cursor?: string
  /** Rows per page (1–100, default 50). */
  limit?: number
}

/** Cursor paging for the location listings (1–100 rows, default 50). */
export interface LocationPageParams {
  cursor?: string
  limit?: number
}

/**
 * Proximity search around a hub. `rangeLy` is the gateway's `range`: light
 * years, default and maximum 3500.
 */
export interface NearbyHubsParams {
  hubId: string
  rangeLy?: number
  /** Only hubs with open orders for this item type, e.g. `"70810"`. */
  assetId?: string
}

/**
 * Proximity search around a solar system rather than a hub — the form to use
 * when the origin hub is private and publishes no location.
 */
export interface NearbyHubsBySystemParams {
  /** Solar system id or name to search from. */
  solarSystem: string
  rangeLy?: number
  /** Only hubs with open orders for this item type, e.g. `"70810"`. */
  assetId?: string
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
   * Each listed asset is withdrawn from the trading account and redeemed into
   * the hangar at the hub: `amount` items (`withdraw_multicoin`), or the full
   * balance when `amount` is omitted (`withdraw_all_multicoin`, the app's
   * sweep semantics).
   */
  items: { assetId: string; amount?: bigint }[]
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
   * Override the quote (CRED) a bid needs in the trading account; defaults to
   * `computeBidQuoteDeposit(price, quantity, fees.bidEscrowFeeRate)` — the
   * notional plus a fee at the pool's highest taker/maker rate, read
   * on-chain, so the order is never under-funded.
   */
  quoteDeposit?: bigint
}

export interface MarketOrderParams {
  storageUnitId: string
  assetId: string
  side: OrderSide
  quantity: bigint
  /**
   * Required for market buys — the CRED cost including the taker fee,
   * typically `estimateMarketBuyCost(book.asks, quantity, takerFeeRate)
   * .total`. The trading account is topped up to this amount; note a market
   * buy can spend whatever the account holds, so this is a funding target,
   * not a price cap.
   */
  quoteBudget?: bigint
  /** 0 = allowed (default), 1 = cancel taker, 2 = cancel maker. */
  selfMatchingOption?: number
}

export interface CancelOrderParams {
  storageUnitId: string
  assetId: string
  /**
   * Order id (Move `u128`), from `orders.openOrders()` / discovery. Keep it as
   * a decimal string or bigint — it exceeds 2^53.
   */
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

export interface CancelOrdersParams {
  storageUnitId: string
  assetId: string
  /** Order ids (Move `u128`) — all must belong to the account, or none cancel. */
  orderIds: (bigint | string)[]
}

/** Identify an item pool by hub + item, or directly by pool id. */
export type PoolSelector =
  { storageUnitId: string; assetId: string } | { poolId: string }

export type TradingFeesParams = PoolSelector & {
  /** Whose tier to resolve; defaults to the client address (if any). */
  address?: string
}

export interface MintCapParams {
  /** `trade` (TradeProof), `deposit` or `withdraw`. */
  kind: TradingAccountCapKind
  /** Who receives the cap; defaults to the trading-account owner. */
  recipient?: string
}

export interface MintCapResult extends TxResult {
  /** The minted cap's object id, when the executor surfaced created objects. */
  capId: string | null
}

export interface RevokeCapParams {
  /** Id of a Trade/Deposit/WithdrawCap on the account's allow-list. */
  capId: string
}

/** Capabilities around one address's trading account. */
export interface TradingAccountCaps {
  /** The address's own trading account, if any. */
  tradingAccountId: string | null
  /** Cap ids live on that account's allow-list (empty without an account). */
  allowListed: string[]
  /** Caps the address holds, for any account. */
  held: OwnedTradingAccountCap[]
}

export interface CreatePoolParams {
  /** Hub whose vault collection the new market trades. */
  storageUnitId: string
  assetId: string
}

export interface CreatePoolResult extends TxResult {
  /** The new pool's id, when the executor surfaced created objects. */
  poolId: string | null
}

export interface ClaimOperatorShareParams {
  /** Item pools to settle the hub operator's fee share for (batched in one PTB). */
  poolIds: string[]
}
