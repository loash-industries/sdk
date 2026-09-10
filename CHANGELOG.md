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
