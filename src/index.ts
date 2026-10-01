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
  BYPASS_FORBIDDEN_PERMISSIONS,
  configFromBcs,
  cooldownEndsAt,
  fetchDaoGovernance,
  fetchFreezeState,
  fetchIsBoardMember,
  fetchOuState,
  fetchProposalConfig,
  fetchTypeSlots,
  governanceFromSlots,
  hasPermissions,
  HIGH_IMPACT_PERMISSIONS,
  normalizeMoveType,
  packageAliases,
  parseFreezeState,
  parseOuState,
  parseTypeSlot,
  permissionFloor,
  PERMISSIONS,
  remapPackages,
  singleVoteExecutable,
  slotForType,
} from './armature/governance'
export type {
  DaoGovernance,
  FreezeState,
  OuState,
  ProposalConfig,
  TypeSlot,
} from './armature/governance'
export {
  canComposite,
  capabilitiesFor,
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
export type { CompositeStep, PlanOptions } from './armature/plan'
export * as armatureTransactions from './armature/transactions'
export type { ProposalConfigInput } from './armature/transactions'
export {
  addMemberAction,
  addMembersAction,
  COMPOSITE_TYPE_CONFIG,
  DEFAULT_SLOT_TYPES,
  disableBypassTypeAction,
  disableProposalTypeAction,
  enableBypassTypeAction,
  enableCompositeAction,
  enableProposalTypeAction,
  enableSendCoinAction,
  enableSendCoinToOuAction,
  enableTradingActions,
  genericTypeKey,
  GOVERNANCE_TYPE_CONFIG,
  removeMemberAction,
  removeMembersAction,
  sendCoinToOuTypeKey,
  sendCoinTypeKey,
  setBoardAction,
  subOuControlType,
  tradingTypeEntries,
  TRADING_TYPE_CONFIG,
  TREASURY_TYPE_CONFIG,
  updateMetadataAction,
  updateProposalConfigAction,
  WHOLE_BOARD_TYPE_CONFIG,
} from './armature/actions'
export type {
  ArmaturePkgs,
  ProposalConfigPatch,
  TradingTypeEntry,
} from './armature/actions'
export {
  compositeStepExecutor,
  defaultSlotType,
  executorForPayload,
  passedProposalAction,
  splitMoveType,
} from './armature/executors'
export type {
  PassedExecutionContext,
  PassedExecutor,
} from './armature/executors'
export {
  appendTransferAssets,
  createSubOuAction,
  HIERARCHY_TYPE_CONFIG,
  pauseSubOuAction,
  reclaimCapFromSubOuAction,
  spawnOuAction,
  spinOutSubOuAction,
  transferAssetsAction,
  transferCapToSubOuAction,
  transferFreezeAdminAction,
  unfreezeProposalTypeAction,
  unpauseSubOuAction,
  updateFreezeConfigAction,
  updateFreezeExemptTypesAction,
} from './armature/lifecycle'
export type { SpinOutConfigs } from './armature/lifecycle'
export {
  adoptCurrencyAction,
  burnCoinAction,
  configureMintAllowanceAction,
  currencyTypeEntries,
  mintAllowanceAction,
  mintAllowanceBypassTx,
  mintCoinAction,
  returnCurrencyCapAction,
  treasuryCapType,
} from './armature/currency'
export type { CurrencyTypeEntry } from './armature/currency'
export {
  appendUpgradeExecution,
  proposeUpgradeAction,
  UPGRADE_POLICY,
} from './armature/upgrade'
export type { UpgradeBuild } from './armature/upgrade'
export { createTribeTx, tradingTypeInits } from './armature/create'
export type { CreateTribeParams, TypeInitInput } from './armature/create'
export {
  capTypeOf,
  fetchCapabilityVault,
  fetchEncryptedEntries,
  fetchFrameStepPayload,
  fetchProposal,
  isDeletable,
  isExecutable,
  parseCapabilityVault,
  parseLiveProposal,
  parseProposalConfigJson,
  payloadTypeOf,
} from './armature/proposals'
export type {
  CapabilityVaultContents,
  EncryptedEntry,
  LiveProposal,
} from './armature/proposals'
export { OrgsWriteApi } from './armature/OrgsApi'
export type {
  CreatedOrg,
  CreateOrgParams,
  OrgsWriteDeps,
} from './armature/OrgsApi'
export type { ExecuteOptions, RunOptions } from './armature/OrgClient'

// ─── Armature: treasury & organization trading ───────────────────────────────
export {
  claimTreasuryCoinsTx,
  depositToTreasuryTx,
  fetchTreasuryCoinBalance,
  fetchTreasuryCoinBalances,
  sendCoinAction,
  sendCoinToOuAction,
  sendSmallPaymentAction,
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
