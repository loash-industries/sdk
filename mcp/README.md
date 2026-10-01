# @trinaryex/mcp

A **keyless, multi-tenant MCP server** for [Trinary Exchange](https://trinary.exchange) — market reads and unsigned transaction preparation for EVE Frontier trading agents.

Released in lockstep with [`@trinaryex/sdk`](https://www.npmjs.com/package/@trinaryex/sdk): **the MCP version always equals the SDK version it wraps.**

## Two invariants

1. **No private keys.** The server never signs and never submits. Write-shaped tools return *unsigned* transaction bytes; you sponsor, sign and submit them with your own key. Full compromise of this service cannot move funds.
2. **No stored credentials.** Every request carries its own API key in a header. The server forwards it upstream for that request and retains nothing — no key store, no tenant table, no database.

That is what makes one shared deployment safe for a whole fleet of agents.

## Quick start

```bash
docker run -p 8080:8080 \
  -e TRIEX_MCP_MODE=prepare \
  -e SUI_GRPC_URL=https://fullnode.testnet.sui.io:443 \
  ghcr.io/loash-industries/triex-mcp:latest
```

Point an MCP client at `POST /mcp` and send your API key as `x-api-key`.

The image is published to GHCR by the release workflow, tagged with the version
it wraps and `latest`, and built for `linux/amd64` and `linux/arm64`. It runs
unprivileged as `node`, carries a `/healthz` HEALTHCHECK, and ships with SBOM
and provenance attestations — the same supply-chain posture as the npm package.
Build it yourself with `docker build -t triex-mcp mcp/` from the repo root.

## Configuration

All configuration is **non-secret** — note the absence of any key, address, or database setting.

| Variable | Default | Purpose |
|---|---|---|
| `TRIEX_MCP_MODE` | `prepare` | `read` registers read tools only; `prepare` adds the prepare tools |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `SUI_GRPC_URL` | testnet fullnode | Fullnode used for object resolution and PTB builds |
| `TRIEX_API_URL` | SDK default | Indexer base URL override |
| `TRIEX_NETWORK` | `testnet` | Network preset |
| `MAX_CONCURRENCY_PER_KEY` | `8` | Fairness cap so one caller cannot starve the fleet |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | — | Serve HTTPS directly; set both or neither |

## Endpoints

| Route | Purpose |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (stateless). Requires `x-api-key` |
| `GET /healthz` | Liveness |
| `GET /readyz` | Readiness, mode and network |

`GET`/`DELETE` on `/mcp` return 405: the server runs stateless, so there are no sessions and no server-initiated streams.

## Tools

**Read** — `market_discover`, `market_search_items`, `market_hub`, `market_items_at_hub`, `market_orderbook`, `market_pool_metadata`, `account_resolve`, `account_balances_at_hub`, `account_currency_balances`, `account_sweepable`, `orders_open`, `orders_fills`, `orders_trades`.

**Locations** — `market_hub_locations`, `market_item_locations`, `market_nearby_hubs`, `market_nearby_hubs_by_system`, `market_hubs_enriched`, `market_assembly_owners`, `market_assemblies_enriched`, `market_solar_system_names`, `account_owners`. These answer *where is it* and *who owns it*: start from `market_hub_locations` or `market_item_locations` when you hold no hub id, then `market_nearby_hubs` to widen the search. All are read tools.

**Spatial (star map)** — `spatial_system`, `spatial_systems`, `spatial_nearby_systems`, `spatial_systems_near_coordinates`, `spatial_autocomplete_systems`, `spatial_stats`. Where solar systems are and what is near what — no account, hub or signer needed. Coordinates are metres and distances light years, both as decimal strings: the values exceed 2^53.

**Prepare** — `prepare_create_account`, `prepare_deposit_currency`, `prepare_deposit_items`, `prepare_withdraw_currency`, `prepare_withdraw_items`, `prepare_claim_settled`, `prepare_limit_order`, `prepare_market_order`, `prepare_cancel_order`, `prepare_cancel_all_orders`, `prepare_modify_order`.

**Organizations (Armature)** — an organization is a *tree* of DAOs, and almost every question about one is really a question about a specific unit: which board votes, whose treasury, whose shared storage. Any unit id resolves the whole tree, so `orgId` is forgiving, but the answers are per-unit.

- *Identity & discovery* — `org_get`, `org_batch`, `org_directory`, `org_for_player`, `org_search`, `org_seats`, `org_trading_account`, `org_proposals`, `org_accessible_keyspaces`.
- *Governance & treasury reads* — `org_governance`, `org_treasury_balances`, `org_treasury_balance`, `org_treasury_item_balance`.
- *Shared storage reads* — `org_vaults_at_hub`, `org_vault_resolve`, `org_vault_info`, `org_vault_balance`.
- *Prepare* — `prepare_org_add_members`, `prepare_org_remove_members`, `prepare_org_set_board`, `prepare_org_update_metadata`, `prepare_org_enable_type`, `prepare_org_update_type_config`, `prepare_org_enable_composite`, `prepare_org_enable_send_coin`, `prepare_org_enable_trading`, `prepare_org_vote`, `prepare_org_execute_proposal`, `prepare_org_expire_proposal`, `prepare_org_treasury_deposit`, `prepare_org_treasury_send`, `prepare_org_treasury_send_to_org`, `prepare_org_setup_trading`, `prepare_org_limit_order`, `prepare_org_cancel_order`, `prepare_org_buy_from_treasury`, `prepare_org_sell_from_vault`, `prepare_org_sweep_coin`, `prepare_org_sweep_items`, `prepare_org_sweep_all`, `prepare_org_vault_init`, `prepare_org_vault_deposit`, `prepare_org_vault_withdraw`, `prepare_org_vault_grant`, `prepare_org_vault_revoke`, `prepare_org_vault_deinit`.

### Governance actions have three outcomes, not one

This is the one way the org prepare tools differ from every other prepare tool, and skipping it will cost you.

The **same call** resolves differently per caller. For an officer whose lone vote clears quorum it executes now; for someone whose does not it creates a **proposal** the board still has to vote on; for a third caller it is refused outright. So:

- `intent.outcome` is `"executed"` or `"proposed"`. **A `proposed` result has not done the thing yet.**
- A refusal returns `prepared: false` with the resolver's `reason` and `code` — an answer, not an error, and there are no bytes to sign.
- Trading tools never degrade into proposals. A limit order deferred by a week is priced against a book that no longer exists, and a funded buy split into two proposals loses its atomic deposit-then-place guarantee, so they return `prepared: false` instead.

`org_governance` is what predicts this: a lone vote clears quorum only when `boardSize × quorum ≤ 10000` and `executionDelayMs` is 0. Pair it with `org_seats` to know which board you are on.

### Two things that bite

**Shared storage is keyed by (storage unit, organization).** There is no "the vault at this hub" — anyone can register one at any SSU, so `org_vaults_at_hub` may well list a stranger's. `org_vault_resolve` answers for *your* organization.

**`prepare_org_enable_trading`'s `bindToBaseType` is irreversible.** It binds the coin-pool order types to one base coin permanently. Leave it unset unless you know why you are setting it.

u64-ish values (prices, quantities, amounts) cross the MCP boundary as **decimal strings**, never JSON numbers.

## The prepare contract

Every `prepare_*` tool returns:

```jsonc
{
  "txKindBytes": "<base64 BCS TransactionKind, onlyTransactionKind>",
  "sender": "0x…",
  "intent": {
    "action": "limit_order",
    "targets": ["0x…::multicoin_pool::place_limit_order"],
    "worstCaseSpend": { "asset": "CRED", "amount": "125625000", "kind": "currency" },
    "params": { "side": "buy", "price": "12500000", "quantity": "10" }
  },
  "pinnedObjects": [{ "objectId": "0x…", "version": "42", "kind": "owned" }],
  "builtAtMs": 1757500000000,
  "notes": ["Verify before signing: …", "Sign promptly. …"]
}
```

### Verify before you sign

`intent.targets` is extracted from the **built transaction**, not reconstructed from your arguments — so checking bytes against intent is meaningful. Before signing:

1. Decode `txKindBytes` and confirm its Move call targets equal `intent.targets`.
2. Confirm every target is on your allowlist. **Package ids are normalized to full 32-byte form** (`0x2` → `0x000…002`); normalize your allowlist the same way or it will never match.
3. Bound the spend against `intent.worstCaseSpend`.
4. Dry-run, and compare the balance deltas to the declared intent.

Never blind-sign bytes produced by another process — including this one.

### Staleness

`pinnedObjects` records the object versions the build resolved. Sign promptly, and never hold two prepared transactions over the same owned objects, or you risk equivocation. `builtAtMs` supports programmatic freshness checks.

### Signing and submitting

Take `txKindBytes` to a gas station for sponsorship, or build gas yourself:

```ts
import { Transaction } from '@mysten/sui/transactions'

const tx = Transaction.fromKind(Buffer.from(txKindBytes, 'base64'))
tx.setSender(sender)
tx.setGasOwner(sponsorAddress)
tx.setGasPayment(gasCoins)
// …verify, then sign with your key and submit
```

## Development

```bash
npm ci
npm test          # unit, parity, schema-snapshot and tenancy suites
npm run tscheck
npm run lint:check && npm run prettier:check
npm run check:parity   # readable lock-step report (builds first)
npm run build && npm start
```

Working against an **unpublished** SDK change? The dependency is a published
version, so a surface added in a sibling checkout is invisible here — and the
parity gate would cheerfully report lock-step against a version that predates
the work. `npm run link:sdk` copies the sibling build in so local checks tell
the truth; `npm install` restores the published copy.

### Lock-step with the SDK

The tool surface is checked against the SDK's **shipped type declarations**, not against a hand-maintained list. `scripts/sdk-surface.mjs` parses `@trinaryex/sdk`'s `.d.ts` with the TypeScript compiler, which gives four things for free:

- `private` helpers are excluded **structurally** — nothing to keep in sync;
- each method's **return type classifies it**: `Promise<TxResult>`, `EnsureAccountResult` or `RunOutcome` is a write, everything else is a read — including intersections like `RunOutcome & { skipped }`;
- **handle sub-APIs are discovered**, not listed: the org handle's groups (`org.governance`, `org.treasury`, …) come from `OrgHandle`'s own property declarations, so adding a group to the SDK cannot silently escape the gate;
- each method's **parameter types resolve** to the property names it accepts, following them into sibling declaration files;
- it describes the **published contract**, which is what consumers actually see.

Lock-step is enforced in two dimensions.

**Coverage.** Every SDK method is either wrapped by a tool **of the matching kind** — writes by a `prepare_*` tool, reads by a read tool — or listed in `EXCLUDED_SDK_PATHS` with a reason. Covering a write with a read tool fails just as loudly as not covering it at all.

**Arguments.** Every tool input must be a parameter its SDK method actually accepts. This catches the quieter drift: an unrecognised property is not refused anywhere, it is dropped in transit, so the tool answers successfully while ignoring what it was asked. A `hubId` filter on a method that filters by `storageUnitIds` returned the entire market; a `cursor` on a timestamp-windowed read paged forever over page one. Both type-checked, and both passed a coverage-only gate.

Two escape hatches exist, and each demands a written reason:

- `GLOBAL_SYNTHETIC_PARAMS`, or a tool's `syntheticParams` — inputs that are genuinely MCP-level rather than SDK-level. `sender` is the only global one, and it exists precisely because this server is keyless.
- a tool's `derivedParams` — required SDK parameters the handler supplies itself instead of accepting from the caller.

The waivers are themselves checked: one naming a real SDK parameter, or one the tool no longer declares, fails as a stale claim.

Read tools resolve against `ReadOnlyClient` as well as the namespaced APIs, since that is the client they actually call.

`npm run check:parity` prints the full report:

```
SDK surface: 25 methods (14 read, 11 write)
MCP tools:   23  ·  explicitly excluded: 2
Parameters:  74 across the surface  ·  waivers: 1 global + 0 per-tool

  ✓ write orders.limit               prepare_limit_order
  ✓ read  market.orderbook           market_orderbook
  – read  market.resolvePool         (excluded)
  …
MCP covers the SDK surface in lock-step.
```

The same checks run in `test/parity.test.ts` on every PR — and that suite includes cases driving the comparison with doctored inputs, so the gate is proven to fail when it should. CI runs it on **all** PRs, not just ones touching `mcp/`, because the drift it catches usually originates in an SDK change.

The **schema snapshot** turns any consumer-visible input change into a reviewable diff.

## License

MIT
