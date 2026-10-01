// ─── Clients ─────────────────────────────────────────────────────────────────
export { TriexClient } from './TriexClient'
export type {
  AccountApi,
  BalancesApi,
  MarketApi,
  OrdersApi,
  SpatialApi,
} from './TriexClient'
export { ReadOnlyClient } from './ReadOnlyClient'
export { OrgsApi } from './armature/OrgsApi'
export { OrgHandle } from './armature/OrgClient'
export type { OrgHandleDeps, RunOutcome } from './armature/OrgClient'
export { OrgQueries, MAX_BATCH_IDS } from './armature/queries'

// ─── Errors ──────────────────────────────────────────────────────────────────
export {
  TriexError,
  TriexClientError,
  explainMoveAbort,
  explainMoveAbortDetailed,
  parseMoveAbort,
  unpackAbortCode,
} from './errors'
export type { MoveAbortExplanation, AbortCodeBits } from './errors'
export { MOVE_ABORT_CATALOG } from './moveAbortCatalog.generated'
export type {
  MoveAbortEntry,
  MoveAbortName,
} from './moveAbortCatalog.generated'

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
  estimateMarketBuyCost,
  marketBuyRoundingBuffer,
  TRIEX_PRICE_SCALING,
  MULTICOIN_PRICE_SCALING,
  FEE_RATE_SCALING,
  GTC_EXPIRE,
} from './money'

// ─── Low-level building blocks (for advanced callers) ────────────────────────
export { IndexerClient } from './queries'
export * as transactions from './transactions'
export {
  getWalletCurrencyBalance,
  getTradingAccountCurrencyBalance,
  getTradingAccountItemBalance,
  getRegistryMulticoinCollectionId,
  findOwnedItemReceipts,
  fetchCharacterInfo,
  fetchSsuOwnerInfo,
  fetchInventorySlotQuantity,
  toSsuObjectId,
  getObjectRef,
} from './onchain'
export {
  prepareWalletCoinInput,
  sourceItemsIntoTradingAccount,
} from './funding'
export {
  normalizeExecuteResult,
  executeAndNormalize,
  findCreatedObject,
} from './execute'
export type { NormalizedExecution, CreatedObject } from './execute'

// ─── Analytics & pagination helpers ──────────────────────────────────────────
export {
  aggregateLevels,
  bestBid,
  bestAsk,
  midPrice,
  spread,
  depth,
  vwap,
} from './book'
export type { BookLevel } from './book'
export {
  iterateDiscovery,
  iterateFills,
  iterateOrgDirectory,
  iterateTrades,
} from './paging'
export type { IterateOptions } from './paging'
export { untilIndexed } from './wait'

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  TriexNetwork,
  PackageIds,
  TriexClientConfig,
  ReadOnlyClientConfig,
  TransactionExecutor,
  ObjectChange,
  TxResult,
  OrderSide,
  TradingAccount,
  CurrencyBalances,
  AssetBalance,
  InventoryBalances,
  TradeHubDetail,
  HubVaultInfo,
  HubLocation,
  HubLocationPage,
  HubLocationFilters,
  LocationPageParams,
  NearbyHub,
  NearbyHubsParams,
  NearbyHubsBySystemParams,
  HubEnriched,
  AssemblyOwner,
  AssemblyEnriched,
  TradingAccountOwner,
  SolarSystemName,
  Coordinates,
  SolarSystem,
  SolarSystemSuggestion,
  NearbySystem,
  NearbySystems,
  NearbySystemsParams,
  BatchSystems,
  BatchSystemsParams,
  CoordinateSearch,
  CoordinateSearchParams,
  AutocompleteSystems,
  SpatialStats,
  HubItem,
  HubItemsPage,
  ItemRecipe,
  ItemRecipeComponent,
  ItemSearchPage,
  ItemSearchResult,
  CollectionHub,
  Orderbook,
  HubItemOrderbook,
  HubItemMarket,
  OrderbookOrder,
  PoolMetadata,
  DiscoveryOrder,
  DiscoveryResult,
  DiscoveryFilters,
  OpenOrder,
  OpenOrdersPage,
  Fill,
  FillsPage,
  Trade,
  TradesPage,
  BalancesAtHubParams,
  HistoryPageParams,
  FillsParams,
  TradesParams,
  Sweepable,
  SweepablePool,
  SweepableItem,
  EnsureAccountResult,
  DepositCurrencyParams,
  DepositItemsParams,
  WithdrawCurrencyParams,
  WithdrawItemsParams,
  LimitOrderParams,
  MarketOrderParams,
  CancelOrderParams,
  CancelAllOrdersParams,
  ModifyOrderParams,
  ClaimSettledParams,
} from './types'
export type {
  OwnedItemReceipt,
  CharacterInfo,
  SsuOwnerInfo,
  ObjectRef,
} from './onchain'

// ─── Armature: organizations & governance ────────────────────────────────────
export {
  execContextFor,
  findNodeAcross,
  flattenOrg,
  nodeById,
  resolveSeat,
  roleForDepth,
  rootNode,
  seatsFor,
  tradingNode,
} from './armature/tree'
export type {
  AccessibleKeyspace,
  HubDaoVault,
  KeyspaceMatchVia,
  KeyspaceRole,
  Org,
  OrgActor,
  OrgDirectoryEntry,
  OrgDirectoryPage,
  OrgDirectoryParams,
  OrgMetadata,
  OrgNode,
  OrgSearchParams,
  OrgSearchResult,
  OrgSeat,
  OuExecContext,
  OuParent,
  ProposalCompositeStep,
  ProposalStatus,
  ProposalSummary,
  VaultAclEntry,
  VaultPrincipal,
  VaultRole,
} from './armature/types'

// ─── Armature: governance core ───────────────────────────────────────────────
export {
  fetchDaoGovernance,
  fetchProposalConfig,
  parseEnabledProposalTypes,
  parseProposalConfigs,
  parseTypeBindings,
  singleVoteExecutable,
} from './armature/governance'
export type { DaoGovernance, ProposalConfig } from './armature/governance'
export {
  canComposite,
  COMPOSITE_TYPE_KEY,
  evaluatePaths,
  MAX_COMPOSITE_STEPS,
  selectStrategy,
} from './armature/harness'
export type {
  BlockCode,
  BlockedPlan,
  CompositeEligibility,
  CompositeIneligibility,
  ExecutionPlan,
  OuCapabilities,
  OuControlAdapter,
  OuOwnAdapter,
  OuProposalAction,
  PathCandidate,
  PathTier,
  ResolvedPlan,
  Strategy,
  StrategyDecision,
} from './armature/harness'
export {
  appendPlanActions,
  buildBatchPlanTx,
  buildCompositeSubmitTx,
  buildExecuteCompositeTx,
  buildExecutePassedTx,
  buildPlanTx,
  extractCreatedProposalId,
  resolveExecutionPlan,
} from './armature/plan'
export type { CompositeStep } from './armature/plan'
export * as armatureTransactions from './armature/transactions'
export type { ProposalConfigInput } from './armature/transactions'
export {
  addMembersAction,
  compositeStepExecutor,
  COMPOSITE_TYPE_CONFIG,
  enableCompositeAction,
  enableProposalTypeAction,
  enableSendCoinAction,
  enableSendCoinToDaoAction,
  enableTradingActions,
  GOVERNANCE_TYPE_CONFIG,
  passedProposalAction,
  removeMembersAction,
  sendCoinToDaoTypeKey,
  sendCoinTypeKey,
  setBoardAction,
  tradingTypeEntries,
  TRADING_TYPE_CONFIG,
  updateMetadataAction,
  updateProposalConfigAction,
} from './armature/actions'
export type { ArmaturePkgs, ProposalConfigPatch } from './armature/actions'

// ─── Armature: treasury & organization trading ───────────────────────────────
export {
  depositToTreasuryTx,
  fetchTreasuryCoinBalance,
  fetchTreasuryCoinBalances,
  fetchTreasuryItemBalance,
  sendCoinAction,
  sendCoinToDaoAction,
  toTypeNameKey,
} from './armature/treasury'
export type { TreasuryCoinBalance } from './armature/treasury'
export {
  appendClaimSettled,
  cancelOrderAction,
  depositCoinToBookAction,
  depositFromDaoVaultToBookAction,
  placeLimitOrderAction,
  setupTradingAccountAction,
  sweepCoinToTreasuryAction,
  sweepMulticoinToDaoVaultAction,
} from './armature/trading'
export type { OrderFlags, TradingContext } from './armature/trading'
export type { OrgLimitOrderParams } from './armature/OrgClient'

// ─── Armature: shared storage (DaoReceiptVault) ──────────────────────────────
export {
  deinitializeDaoVaultTx,
  depositReceiptTx,
  fetchDaoVaultInfo,
  fetchVaultBalance,
  grantEditOuTx,
  grantTx,
  initializeDaoVaultTx,
  principalVec,
  resolveDaoVaultId,
  revokeTx,
  roleVec,
  sourceWalletReceipts,
  toStorageUnitId,
  VaultKeyBcs,
  withdrawReceiptTx,
} from './armature/vault'
export type { DaoVaultInfo } from './armature/vault'
export type { OrgSweepSkip } from './armature/OrgClient'

// ─── Coins: currency-pair markets (triex::pool) ──────────────────────────────
export {
  CoinsApi,
  CoinsReadApi,
  DEFAULT_SWAP_SLIPPAGE_BPS,
} from './coins/CoinsApi'
export type { CoinsReadDeps } from './coins/CoinsApi'
export {
  COIN_MAX_FILLS,
  COIN_MAX_PRICE,
  COIN_MIN_PRICE,
  COIN_POOL_CREATION_FEE,
  COIN_PRICE_SCALING,
  coinMinOrderQuantity,
  coinPriceDecimals,
  coinPriceToRaw,
  coinQuoteFee,
  coinQuoteForBase,
  coinSellNet,
  computeCoinBidDeposit,
  conservativeBidFeeRate,
  estimateCoinMarketOrder,
  formatCoinPrice,
} from './coins/money'
export type {
  CoinFeeRates,
  CoinMakerOrder,
  CoinMarketEstimate,
} from './coins/money'
export * as coinTransactions from './coins/transactions'
export type { CoinPoolTypes } from './coins/transactions'
export {
  COIN_ORDER_STATUS,
  CoinBalancesBcs,
  CoinFeeScheduleBcs,
  CoinOrderBcs,
  CoinOrderPageBcs,
  CoinPoolAccountBcs,
  dryRunCoinQuantityOut,
  fetchCoinAccountOrders,
  fetchCoinBookSide,
  fetchCoinPoolAccount,
  fetchCoinPoolTypes,
  fetchCoinTradeParams,
  getTradingAccountCoinBalance,
  resolveCoinPoolId,
  simulateReturnValues,
} from './coins/onchain'
export type {
  CoinBookOrder,
  CoinBookSide,
  CoinPoolAccount,
  CoinPoolBalances,
  CoinTradeParams,
} from './coins/onchain'
export {
  depositCoinDeficit,
  isSuiCoinType,
  prepareCoinInput,
} from './coins/funding'
export type {
  CoinAccountParams,
  CoinBalances,
  CoinBalancesParams,
  CoinCancelOrderParams,
  CoinCancelOrdersParams,
  CoinClaimSettledParams,
  CoinDepositParams,
  CoinInfo,
  CoinLimitOrderParams,
  CoinMarket,
  CoinMarketEstimateParams,
  CoinMarketOrderParams,
  CoinMintPolicy,
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
  CoinTreasuryHolding,
  CoinWithdrawParams,
  CreateCoinPoolParams,
  CreateCoinPoolResult,
} from './coins/types'
