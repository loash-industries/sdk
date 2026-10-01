## 4.0.0 (2026-10-01)

* feat!: Cycle 7 SDK ([dffa2d4](https://github.com/loash-industries/sdk/commit/dffa2d4)), closes [#171](https://github.com/loash-industries/sdk/issues/171)

### BREAKING CHANGE

* *DaoVault* builders/types renamed *OuVault*;
orders.sellFromDaoVault -> sellFromVault; daoVaultId -> vaultId;
editorDaoId -> editorOuId; sweepCoin quoteType -> coinType;
TradingContext drops capVaultId for tradingCustodyId + feePolicyId;
OrgHandle.tradingContext() removed.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* test: expect effects in the fee-read simulate include

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* docs(armature): document the cycle-7 vault and trading port

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* refactor(coins): share the quote-fee formula with item pools

Both pool kinds charge through quote_fee::fee_from_scaled_rate, so
coinQuoteFee now delegates to computeQuoteFee instead of restating it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(armature): fund org bids at the on-chain escrow fee rate

buyFromTreasury sized its default treasury deposit from the indexer's pool
fee — the tier-0 TAKER rate only, and null when unindexed. Cycle-7 triex
escrows the maker fee on a resting bid and ladders both rates, so use
getPoolTradingFees().bidEscrowFeeRate, the same read personal bids use.
getPoolTradingFees takes the pool's quote type, since org orders may quote
in a coin other than CRED.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(mcp): discover API groups structurally in the parity gate

The gate found groups by class name in two hand-kept maps, so client.coins —
declared in coins/CoinsApi.d.ts, with its reads inherited from
CoinsReadApi — was invisible: twenty-two SDK methods with no tool and a
green gate. Writes were classified by exact return-type name, so
account.mintCap (MintCapResult) and market.createPool (CreatePoolResult)
read as reads, which would have let a read tool cover a write.

Groups are now discovered by walking each root's (TriexClient, OrgHandle)
public properties through the type checker to their class declarations,
including base classes, wherever they are declared. A return type is a
write when it is, or extends, a write type. Protected members are excluded
like private ones.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(config): add triexOriginal for upgrade-safe struct types

Type filters and dynamic-field key types (TradingAccount, the cap types,
BalanceKey<T>, MultiCoinBalanceKey) were built from the current triex id.
Objects keep the type tag of the package version that defined them, so
these would silently miss every account and balance after the first triex
upgrade. They now use PackageIds.triexOriginal; moveCall targets keep the
current id. The cycle-7 preset sets both to the fresh publish.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(sdk): wrap the whole published gateway read surface

Every operation api.trinary.exchange publishes now has an SDK method,
except /v1/coins (coin-pool module) and the deprecated /v1/tribes/{id}
alias, which proxies the same upstream as /v1/world/tribes/{id}.

New reads, on IndexerClient, ReadOnlyClient and TriexClient:
- orders.get / ro.order: one order on one pool in any state (open,
  filled, cancelled) with owner, hub, currency and fill history.
  Order ids (u128) are validated and sent as decimal.
- orders.fill / ro.fill: one fill by event digest, both sides' fees.
- market.recentTrades, displayPrices, displayPrice, hubEconomics,
  topPoolsByFees, stats.
- New groups: routing (route, compare, stats), characters (get,
  byAddress, byName, batch, tribe), world (items, item, recipes,
  recipesFor).
- Iterators: iterateRecentTrades, iterateOpenOrders,
  iterateHubLocations, iterateItemLocations. The epoch-ms walkers
  (fills, trades) now stop on a null nextCursor instead of paying for a
  trailing empty page.
- TriexError: OrderNotFound, FillNotFound, TribeNotFound, ItemNotFound,
  RouteNotFound.

Drift fixed against the live contract:
- SweepableItem.storage_unit_id / vault_config_id are nullable upstream;
  one unlinked item made the whole sweep manifest (claimSettled,
  sweepAll) fail to parse. Unindexed links now map to '' (the existing
  "empty = not indexed" convention).
- location-api's cycle-7 names change (deployed, not yet in the
  published spec): SolarSystem / NearbySystems names accept string, null
  or absent; spatial stats gain knownSolarSystemNames. Names are
  player-reported now, so docs steer callers to ids.
- Pool metadata's fee is the fee class's entry tier (an upper bound);
  display prices carry no fee; the tape's fee_rate_bps is per fill.

Gates: test/gateway.test.ts fails when a live, non-deprecated operation
goes unwrapped; test/schema-conformance.test.ts parses payloads
synthesised from every wrapped operation's response schema (required-only
with nulls, and full) plus the spec's own examples. check:gateway lists
unwrapped operations and marks deprecated ones.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* docs: document the full gateway read surface and smoke it live

README: API table gains the routing / characters / world groups, the
market feeds and order/fill lookups, the new iterators and error codes,
plus notes on player-reported solar system names and fee-free display
prices. DESIGN.md: section 2 story 14 points at /v1/trading-accounts,
new section 2.1 maps the added reads with CU costs and the cycle-7
semantics that change how results read, section 5.2 lists the new
methods, and section 13 is now the full 60-operation published surface
mapped to SDK methods.

scripts/smoke.mjs exercises every new read against the live gateway
(order and fill lookups, tape, display prices, hub economics, fee
ranking, stats, characters and tribes, world items and recipes, star-map
and routing stats, and a route between two reported names).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(armature): skip unlinked stacks in sweepAll instead of aborting

The sweepable read now maps a null hub link to storageUnitId ''. sweepAll
fed that to vault resolution, which cannot key a vault on an empty id, so
one unlinked stack failed the whole sweep. Such stacks are now reported in
skipped with reason 'unlinked', like stacks whose hub has no vault.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(armature)!: port organizations & governance to cycle-7 Armature

Port the governance core, action catalog and handle to armature main
* balance-manager-named parameters, fields and types are
renamed to trading-account names, matching the indexer and contracts.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* chore: refresh MCP schema snapshot for the trading-account rename

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat!: complete the item-trading surface against trinary-exchange main

Fee model (cycle 7): both sides pay, quote-denominated, floor(quote x rate / 1e9).
Bids pay the taker fee on the matched quote and escrow the maker fee on the
resting quote; asks pay out of their proceeds. Rates come from the pool's
FeePolicy class, tiered by the account's trailing fee turnover.

- orders.fees() / getPoolTradingFees(): one simulated transaction of the
  multicoin_pool / fee_policy view functions returns the ladder, the staged
  ladder, cancel retention, and the account's own tier, turnover and rates.
- orders.limit() funds bids at bidEscrowFeeRate = max(tier-0 taker, tier-0
  maker) over the active and staged ladders, read on-chain instead of the
  indexer's taker-only `fee` (which defaulted to 0n when unknown).
- orders.market() deposits exactly quoteBudget: the taker fee is now floored
  once on the aggregate, so the per-fill rounding buffer is obsolete.
- money: computeQuoteFee, computeAskProceeds, estimateMarketSellProceeds;
  estimateMarketBuyCost sorts its input; marketBuyRoundingBuffer deprecated.

New entry points: account.register/mintCap/revokeCap/caps, partial
withdrawItems (withdraw_multicoin), orders.cancelMany (cancel_orders),
market.createPool (create_permissionless_pool) and market.claimOperatorShare;
builders for cap-gated deposits/withdrawals, proofs as trader, custom-owner
constructors, swaps, permissionless settlement and allowed-version sync.

Fixes: the trading-account cache is keyed by owner (reads for another address
no longer return the configured player's account); item sourcing no longer
falls back to the removed registry MultiCoinCollectionKey.
* CreatedOrg.tx is gone; read digest/createdObjects/raw
directly off the result. Same for orgs.createStandalone.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(execute): accept simulateTransaction results from an executor

A simulate result has the TransactionResult shape but carries its digest
only in the effects, so a simulate-only executor — a dry run that previews
any write against the live packages without signing — was rejected as an
unrecognized result. Fall back to effects.transactionDigest.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(coins): explain an unregistered Currency before creating a pool

create_permissionless_pool reads both coins' coin_registry::Currency<T>. A
coin still on legacy CoinMetadata has none — CRED on testnet today — and
the fullnode failed the build with a bare object-not-found. Preflight both
Currency objects and refuse with ValidationFailed naming the coin and
coin_registry::migrate_legacy_metadata.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(mcp)!: bring Armature tools in lock-step with the cycle-7 SDK

Cover every cycle-7 orgs.* / org.* method: 97 Armature tools (22 read,
75 prepare), up from 47. No new exclusions were needed.

New reads: org_proposal, org_expired_proposals, org_freeze, org_entries,
org_capabilities. org_governance now also returns slots, the unit state
(migration/pause flags) and its freeze state.

New prepare tools: org creation (orgs.create / createStandalone), currency
(8), sub-unit lifecycle (9), emergency freeze (6), encrypted entries (5,
indexing already-uploaded ciphertext only), upgrade.propose, bypass
enable/disable, types.disable / enableSendCoinToOrg /
enableSendSmallPayment, treasury.claim / sendSmall, governance
deleteExpired / deleteExhaustedFrame, orders.market / deposit / limitCoin /
cancelCoin / enableCoinPair / createPool, vault.rekey.

Every governance write now accepts RunOptions (unitId, metadataIpfs);
vote takes unitId; execute takes ExecuteOptions (freezeAdminCapId,
treasuryCapId, upgrade, deleteFrame); vault principals accept "machine";
ProposalConfigInput's permissions / borrowScope are exposed; org order
ids are u128.

Fixes:
- intent.outcome is now derived from the built transaction
  (board_voting::submit_proposal / composite::submit_composite =>
  "proposed"). Under the capture executor the SDK never returns its
  RunOutcome, so every governance prepare previously reported "executed",
  including ones that only create a proposal. It is now also reported at
  intent.outcome, as the README always documented, as well as
  intent.params.outcome.
- prepare_org_sweep_all now actually reports intent.params.skipped; the
  SDK's skipped list never surfaced under capture, so it is recomputed
  from the same manifest and vault lookup before the build.
* cycle-7 Move ABI. tryExpire -> deleteExpired,
members.setBoard takes { add, remove }, *Dao* treasury helpers renamed
*Ou*, fetchTreasuryItemBalance / treasury.itemBalance removed,
parseProposalConfigs / parseTypeBindings / parseEnabledProposalTypes
removed, enableTrading's bindToBaseType removed.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(mcp): stop aliasing ReadOnlyClient sub-APIs onto its flat methods

The parameter gate merges a namespaced method's params with the
ReadOnlyClient method of the same name, because read tools call the flat
ReadOnlyClient. That is right for flattened groups (orders.openOrders ->
openOrders) but wrong for groups ReadOnlyClient exposes whole: coins.orderbook
borrowed the item book's orderbook(storageUnitId, assetId) and demanded
inputs the coin book never takes, and coins.openOrders silently accepted
history paging it drops. Skip aliasing for any namespace that is a public
property of ReadOnlyClient (coins, orgs).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(mcp): cover coin pools, account caps and item-pool lifecycle

Bring the personal trading surface back into lock-step with the SDK.

Coin markets (client.coins): eight read tools (coins_list, coins_orderbook,
coins_trade_params, coins_quote, coins_estimate_market, coins_open_orders,
coins_account, coins_balances) and eleven prepare tools (prepare_coin_deposit,
_withdraw, _limit_order, _market_order, _swap, _cancel_order,
_cancel_many_orders, _cancel_all_orders, _modify_order, _claim_settled,
_create_pool). coins.resolvePool is excluded as internal plumbing, like
market.resolvePool. Coin prepare tools resolve the pool once and, where the
SDK would size a figure from a live read (bid deposit, market-buy budget,
swap minOut), run that read first and pass it in, so worstCaseSpend and
intent.params state exactly what the bytes commit to, in full coin types.

Account / orders / market: account_caps and orders_fees reads;
prepare_register_account, prepare_mint_account_cap,
prepare_revoke_account_cap, prepare_cancel_many_orders, prepare_create_pool
and prepare_claim_operator_share.

Wiring: the per-request ReadOnlyClient now carries the shared, credential-free
fullnode client (coins.* reads are on-chain simulations), and writeClient's
sender is optional for TriexClient-only fullnode reads that take their address
per call.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* refactor(armature)!: make org creation results TxResults

orgs.create returned { orgId, officersId, membersId, tx } and
createStandalone { ouId, tx }; every other write result extends TxResult.
Flatten both (CreatedOrg / new CreatedOu extend TxResult) so callers read
digest the same way everywhere and the MCP parity gate classifies them as
writes.
* getRegistryMulticoinCollectionId is removed — the
registry::MultiCoinCollectionKey field no longer exists on-chain.
* orders.limit bid deposits and orders.market buy deposits
changed (on-chain max taker/maker rate; no rounding buffer), and both
orders.limit (bids) and orders.fees need a Sui client whose
simulateTransaction returns commandResults (gRPC / GraphQL).
* PackageIds gains the required field triexFeePolicy.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(config): point the testnet preset at the TRIEX-158 triex republish

triex 0xdbf259ed...2945, Registry 0x2f37ad13...22c2, FeePolicy 0xcd634027...3748 (trinary-exchange main 40f46ad). The previous publish 0xa9dfa639... is abandoned.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat!: rename balance manager to trading account; cycle-7 armature ids

The indexer finished the rename the contracts started: every
/v1/balance-managers/* route is now /v1/trading-accounts/*, the
balance_manager_id query param on /v1/discovery and /v1/inventory/balances
is trading_account_id, and response bodies carry *_trading_account_id
fields. The old routes 404 on the live gateway, and the old query param is
silently ignored, so open-orders/fills/trades/sweepable/owners reads and
"my orders" discovery filtering were broken against the deployed gateway.

The SDK's public API follows the wire: balanceManagerId → tradingAccountId,
BalanceManagerOwner → TradingAccountOwner, getBalanceManagerCurrencyBalance
→ getTradingAccountCurrencyBalance, and so on. TriexError keeps
BalanceManagerNotFound as a deprecated alias of TradingAccountNotFound.

Also points the Armature preset at the cycle-7 fresh publishes (framework,
proposals, vault, trading) and the OuReceiptVaultRegistry; drops
armatureWorldBridge, which nothing read and cycle 7 did not republish.
Refreshes the vendored gateway contract.
* tool inputs renamed or removed to match the cycle-7 SDK:
- prepare_org_set_board: addresses -> add / remove (a board diff)
- prepare_org_enable_trading: bindToBaseType removed (use
  prepare_org_enable_coin_pair per pair)
- prepare_org_sweep_coin: quoteType -> coinType (+ claimFromCoinPool)
- prepare_org_sweep_items, prepare_org_vault_deposit,
  prepare_org_vault_withdraw, prepare_org_sell_from_vault:
  daoVaultId -> vaultId
- prepare_org_vault_grant, prepare_org_vault_revoke,
  prepare_org_vault_deinit: editorDaoId -> editorOuId
Tools removed: org_treasury_item_balance (SDK dropped
treasury.itemBalance); prepare_org_expire_proposal is replaced by
prepare_org_delete_expired_proposals (governance.deleteExpired, takes
proposalIds[]).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(mcp): pass account_balances_at_hub params as one object

ReadOnlyClient.balancesAtHub takes a single
`BalancesAtHubParams & { tradingAccountId? }` object, but the tool called
it with two positional strings. The SDK then read `storageUnitId` off a
string, so every request went to /v1/inventory/balances with no hub and
no trading account.

The tool now passes the params object, and exposes the other section
selectors the read honours (address -> warehouse, inventoryKey -> hangar,
vaultIds -> orgVaults). tradingAccountId becomes optional; a call naming
no section at all is refused before it spends 50 CU on four empty lists.
Tests pin the outgoing URL and query keys with a mocked fetch.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(mcp): wrap the SDK's indexer read surface

Twenty read tools bring the MCP back into lock-step with the SDK's new
gateway reads, each a keyless ReadOnlyClient call with identity explicit:

- market_recent_trades, market_display_prices, market_display_price,
  market_hub_economics, market_top_pools_by_fees, market_stats
- orders_get, orders_fill
- routing_route, routing_compare, routing_stats
- characters_get, characters_by_address, characters_by_name,
  characters_batch, characters_tribe
- world_items, world_item, world_recipes, world_recipes_for

Market and order reads extend read.ts; players, world data and routing
live in a new tools/world.ts. Descriptions give units, CU cost and what
to pair each read with, and flag the two unit traps: the public tape's
human-readable decimals and fee-less display prices.

Routing is name-only and, since cycle 7, names are player-reported, so
the routing tools refuse an all-digit origin/destination at the schema
instead of spending 100-300 CU on a guaranteed RouteNotFound.
characters_by_address requires its address: the server has no
configured player for the SDK's default to fall back on.

Tests pin URL and query keys for the new reads against a mocked fetch,
plus the routing name-only behaviour. The schema snapshot diff is
additions only. README tool lists and parity counts updated.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(errors): explain Armature aborts too

The abort catalog was generated from trinary-exchange only, so every
organization abort — not a board member, type not enabled, missing
permission bit, empty treasury, frozen type, vault role — came back
unexplained. Simulating org writes against testnet surfaced exactly that.

The generator now reads all four contract repos (trinary-exchange,
armature, armature-vault, armature-trading; each required, each with a
flag and env var): 291 constants across 43 modules, up from 104 across 16.
Curated text covers the aborts an officer is most likely to hit.

armature-vault's ou_receipt_vault declares ENotAuthorized as
#[error(code = 0)], which the generator rejected as indistinguishable from
a bare #[error]. That ambiguity only exists when the module also has bare
errors; ou_receipt_vault has none, so code 0 is admitted there and the
lookup falls back to it for a clever abort with zero code bits.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* test(config): pin every cycle-7 package id, not just triex and world

The preset pin covered triex, its shared objects, multicoin, warehouse
receipts and world, but not the four Armature ids or the vault registry, so
a stale Armature id could ship green. Pin the whole deployment table, and
assert each *Original equals its id after the fresh cycle-7 publish.

Also moves abort-parsing fixtures off pre-cycle-7 triex addresses (the
retired-balance_manager cases keep theirs on purpose).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* ci(mcp): validate the MCP against this commit's SDK

MCP validation installed @trinaryex/sdk from npm, so any PR that adds SDK
surface together with its tools failed on exports that exist only on the
branch — and the parity gate graded the MCP against a release it would never
ship with. On main the same job ran beside `release`, still against the old
npm version, so a release that grew the SDK would block publish-mcp.

The new reusable mcp-validate.yml builds the SDK at the checked-out commit
and copies it into mcp/node_modules (`npm run link:sdk`, as in local
development) before lint, prettier, tscheck and test:cov. Both the PR
workflow and publish.yml's validate-mcp use it; job names are unchanged, so
check names stay `validate-mcp / linters` and `validate-mcp / unit-tests
(test:cov)`.

publish-mcp still builds the released package against the SDK version it
pins from npm, and now waits for that version to reach the registry first,
since it runs immediately after `release` publishes it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
* TriexClient#rememberTradingAccountId (internal) now takes
(owner, id).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(coins): trade coin (currency-pair) pools via client.coins

Cycle 7 merged coin pools (triex::pool::Pool<Base, Quote>) into the main
triex package. Add a `coins` group on TriexClient (reads + writes) and a
read-only `coins` on ReadOnlyClient (optional suiClient):

- writes: limit, market, swap (wallet-to-wallet), cancel, cancelMany,
  cancelAll, modify, claimSettled, createPool, deposit/withdraw of any coin
- reads: list (GET /v1/coins), resolvePool, orderbook (coin_order_query
  iter_orders), tradeParams (live FeePolicy), quote (get_quantity_out_*),
  estimateMarket, openOrders, account, balances — fullnode simulations,
  since the coin-pool indexer routes are not on the gateway
- money: 1e9 price scaling, fee_from_scaled_rate, price-derived minimum
  size, and a bid deposit at max(entry taker/maker, staged) that provably
  covers every fill split (brute-force tested)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* fix(onchain): report the simulated epoch in getPoolTradingFees

The v2 core client only fills Transaction.epoch from the effects, so the
fee read always returned epoch: null. Verified live on testnet (epoch 1239,
pool fee class 1, tier-0 2.2% taker / 1.8% maker, 20% cancel retention).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* docs(coins): document the coins group and lift OQ-5

Add DESIGN-COINS.md (data sources, entry-point inventory, cycle-7 money
model with Move references, deposit bound, open questions), a README
section + API-surface row, and point DESIGN.md's coin-pool non-goal at it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>

* feat(armature)!: port shared storage and org trading to cycle 7

armature_vault: dao_receipt_vault -> ou_receipt_vault (initialize_ou_vault,
deinitialize_ou_vault, VaultKey.registrant_ou_id), Machine principals
(acl::machine, indexer principal_kind 'machine'), edit grantable to any
principal, update_registry_key wrapped as vault.rekey(). ACL reads parse
Move enums in gRPC (@variant) and JSON-RPC shapes; vault.balance() now
reads the dynamic OBJECT field (it always returned 0 before).

armature_trading: TRIEX-158 custody - every handler takes the shared
TradingCustody (resolved from the account's owner) instead of a
CapabilityVault, FeePolicy follows the pool on order handlers, order ids
are u128. Orders act through the unit that owns the custody. New:
market orders, coin-pool limit/cancel (per-pair display keys,
enableCoinPair), CreateMulticoinPool, standalone deposit, coin-pool
claim. Bundles resolve every step, and keys follow the OU's typeBindings.
buyFromTreasury gains a bidFeeRate seam for cycle-7 fee sizing.

## 3.9.0 (2026-09-11)

* feat(mcp): expose CRED balances and the star map ([21c9a9b](https://github.com/loash-industries/sdk/commit/21c9a9b))

## 3.8.0 (2026-09-11)

* test(sdk): cover balances.currency, including the no-account path ([3ae1c7b](https://github.com/loash-industries/sdk/commit/3ae1c7b))
* feat(sdk): add the spatial (star map) surface ([2be4e19](https://github.com/loash-industries/sdk/commit/2be4e19))

## 3.7.0 (2026-09-11)

* feat(mcp): add the location tools and require sdk 3.6.0 ([d1508ed](https://github.com/loash-industries/sdk/commit/d1508ed))

## 3.6.0 (2026-09-11)

* feat(sdk): wrap the gateway's location surface ([71f46c4](https://github.com/loash-industries/sdk/commit/71f46c4))

## 3.5.0 (2026-09-10)

* Merge pull request #6 from loash-industries/build/mcp-container-image ([18380c7](https://github.com/loash-industries/sdk/commit/18380c7)), closes [#6](https://github.com/loash-industries/sdk/issues/6)
* Merge pull request #7 from loash-industries/fix/mcp-provenance-repository ([bce84ef](https://github.com/loash-industries/sdk/commit/bce84ef)), closes [#7](https://github.com/loash-industries/sdk/issues/7)
* Merge pull request #8 from loash-industries/feat/mcp-keyspace-reads ([68d51e4](https://github.com/loash-industries/sdk/commit/68d51e4)), closes [#8](https://github.com/loash-industries/sdk/issues/8)
* chore(deps): bump @trinaryex/keyspace to 8.3.1 ([f263d82](https://github.com/loash-industries/sdk/commit/f263d82))
* feat(mcp): add keyless Keyspace lookup tools ([4d2fcb4](https://github.com/loash-industries/sdk/commit/4d2fcb4))
* build(mcp): publish a multi-arch, attested container image ([60f96af](https://github.com/loash-industries/sdk/commit/60f96af))
* build(mcp): publish a multi-arch, attested container image ([f1a8885](https://github.com/loash-industries/sdk/commit/f1a8885))

## 3.4.0 (2026-09-10)

* Merge pull request #5 from loash-industries/fix/mcp-provenance-repository ([bd5350e](https://github.com/loash-industries/sdk/commit/bd5350e)), closes [#5](https://github.com/loash-industries/sdk/issues/5)
* feat(mcp): enforce lock-step on arguments, not just method coverage ([0a30ef2](https://github.com/loash-industries/sdk/commit/0a30ef2))
* feat(sdk): check every request against the gateway's published contract ([b57939d](https://github.com/loash-industries/sdk/commit/b57939d))

## <small>3.3.1 (2026-09-10)</small>

* Merge pull request #4 from loash-industries/fix/mcp-provenance-repository ([8136129](https://github.com/loash-industries/sdk/commit/8136129)), closes [#4](https://github.com/loash-industries/sdk/issues/4)
* fix(mcp): declare repository metadata for provenance publishing ([494bfe9](https://github.com/loash-industries/sdk/commit/494bfe9))

## 3.3.0 (2026-09-10)

* Merge pull request #3 from loash-industries/feat/mcp-server ([5551f83](https://github.com/loash-industries/sdk/commit/5551f83)), closes [#3](https://github.com/loash-industries/sdk/issues/3)
* feat(mcp): add keyless MCP server that prepares unsigned transactions ([1b19e06](https://github.com/loash-industries/sdk/commit/1b19e06))
* feat(mcp): enforce kind-aware lock-step coverage of the SDK surface ([906e9db](https://github.com/loash-industries/sdk/commit/906e9db))
* fix(ci): grant the MCP validate workflow the permissions its reusable job needs ([2cb907a](https://github.com/loash-industries/sdk/commit/2cb907a))
* fix(ci): grant the SDK validate workflow the permissions its reusable job needs ([0370dac](https://github.com/loash-industries/sdk/commit/0370dac))
* fix(test): keep root jest from collecting the mcp package's tests ([2e44429](https://github.com/loash-industries/sdk/commit/2e44429))

## <small>3.2.1 (2026-08-23)</small>

* fix(market): point searchItems at /v1/world/items/search ([67081d2](https://github.com/loash-industries/sdk/commit/67081d2))

## 3.2.0 (2026-08-22)

* feat: add market.searchItems — resolve item names to asset IDs ([3d4de0e](https://github.com/loash-industries/sdk/commit/3d4de0e))

## 3.1.0 (2026-08-22)

* Merge pull request #2 from loash-industries/feat/hub-item-orderbook ([c8816bd](https://github.com/loash-industries/sdk/commit/c8816bd)), closes [#2](https://github.com/loash-industries/sdk/issues/2)
* feat: fetch hub-item order books in one indexer call ([7e87228](https://github.com/loash-industries/sdk/commit/7e87228)), closes [#6](https://github.com/loash-industries/sdk/issues/6) [#53](https://github.com/loash-industries/sdk/issues/53)

## 3.0.0 (2026-08-22)

* Merge pull request #1 from loash-industries/chore/drop-deepbook-triexbook-branding ([98e23ef](https://github.com/loash-industries/sdk/commit/98e23ef)), closes [#1](https://github.com/loash-industries/sdk/issues/1)
* chore: drop DeepBook/triexbook branding from docs and package IDs ([575a8c6](https://github.com/loash-industries/sdk/commit/575a8c6))

### BREAKING CHANGE

* PackageIds.triexbook is renamed to PackageIds.triex, and
the exported TRIEXBOOK_PRICE_SCALING constant is renamed to
TRIEX_PRICE_SCALING. Callers passing packageIds.triexbook as a config
override or importing TRIEXBOOK_PRICE_SCALING must update to the new names.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

## 2.0.0 (2026-08-22)

* feat!: drop client-side OHLCV candles from the public surface ([67e903f](https://github.com/loash-industries/sdk/commit/67e903f))
* docs: refresh README for 1.0.0 and link the marketplace + API docs sites ([075e4f9](https://github.com/loash-industries/sdk/commit/075e4f9))

### BREAKING CHANGE

* `bucketTrades` and the `Candle` type are no longer exported.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## 1.0.0 (2026-08-22)

* ci: adopt shared public-workflows validate/publish pipelines ([a0330c2](https://github.com/loash-industries/sdk/commit/a0330c2))
* feat: analytics + pagination helpers, executor DX, examples, CI, packaging ([dac2b64](https://github.com/loash-industries/sdk/commit/dac2b64))
* feat: full live-testnet trading lifecycle verified (scripts/lifecycle.mjs) ([266ddf6](https://github.com/loash-industries/sdk/commit/266ddf6))
* feat: implement deposits, withdrawals, claims, and the order family (Phases 2-3) ([68cc6af](https://github.com/loash-industries/sdk/commit/68cc6af))
* feat: implement read core against published gateway (Phase 1) ([2fc68c8](https://github.com/loash-industries/sdk/commit/2fc68c8))
* feat: scaffold @trinaryex/sdk trading SDK ([8a39ad8](https://github.com/loash-industries/sdk/commit/8a39ad8))
* feat: specific typed error codes per failure reason + per-method throws docs ([eca3a9d](https://github.com/loash-industries/sdk/commit/eca3a9d))
* feat: untilIndexed wait helper and client-side OHLCV candles ([a910224](https://github.com/loash-industries/sdk/commit/a910224))
* docs: record completed live integration in DESIGN status ([e92b489](https://github.com/loash-industries/sdk/commit/e92b489))
* fix: wrap pre-submit Move aborts from throwing executors as typed errors ([db5e564](https://github.com/loash-industries/sdk/commit/db5e564))
* test: direct coverage for on-chain resolution and hangar sourcing ([b38dea2](https://github.com/loash-industries/sdk/commit/b38dea2))
