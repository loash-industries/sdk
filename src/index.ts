// ─── Clients ─────────────────────────────────────────────────────────────────
export { TriexClient } from './TriexClient'
export type {
  AccountApi,
  BalancesApi,
  MarketApi,
  OrdersApi,
} from './TriexClient'
export { ReadOnlyClient } from './ReadOnlyClient'

// ─── Errors ──────────────────────────────────────────────────────────────────
export { TriexError, TriexClientError } from './errors'

// ─── Config ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_INDEXER_URL,
  CLOCK_ID,
  STILLNESS_PACKAGE_IDS,
  NETWORK_PRESETS,
  resolvePackageIds,
} from './config'

// ─── Money helpers ───────────────────────────────────────────────────────────
export {
  toBase,
  fromBase,
  computeItemQuote,
  computeBidQuoteDeposit,
  TRIEXBOOK_PRICE_SCALING,
  MULTICOIN_PRICE_SCALING,
} from './money'

// ─── Low-level building blocks (for advanced callers) ────────────────────────
export { IndexerClient } from './queries'
export * as transactions from './transactions'

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  TriexNetwork,
  PackageIds,
  TriexClientConfig,
  ReadOnlyClientConfig,
  TransactionExecutor,
  ExecuteResult,
  ObjectChange,
  TxResult,
  OrderSide,
  TradingAccount,
  CharacterBalances,
  ItemBalance,
  TradeHubDetail,
  HubItemListing,
  Orderbook,
  OrderbookLevel,
  PoolMetadata,
  DiscoveryOrder,
  DiscoveryResult,
  OpenOrder,
  Fill,
  Trade,
  EnsureAccountResult,
  DepositCurrencyParams,
  DepositItemsParams,
  WithdrawCurrencyParams,
  WithdrawItemsParams,
  LimitOrderParams,
  MarketOrderParams,
} from './types'
