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
