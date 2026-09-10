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

**Read** — `market_discover`, `market_search_items`, `market_hub`, `market_items_at_hub`, `market_orderbook`, `market_pool_metadata`, `account_resolve`, `account_balances_at_hub`, `account_sweepable`, `orders_open`, `orders_fills`, `orders_trades`.

**Prepare** — `prepare_create_account`, `prepare_deposit_currency`, `prepare_deposit_items`, `prepare_withdraw_currency`, `prepare_withdraw_items`, `prepare_claim_settled`, `prepare_limit_order`, `prepare_market_order`, `prepare_cancel_order`, `prepare_cancel_all_orders`, `prepare_modify_order`.

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

### Lock-step with the SDK

The tool surface is checked against the SDK's **shipped type declarations**, not against a hand-maintained list. `scripts/sdk-surface.mjs` parses `@trinaryex/sdk`'s `.d.ts` with the TypeScript compiler, which gives three things for free:

- `private` helpers are excluded **structurally** — nothing to keep in sync;
- each method's **return type classifies it**: `Promise<TxResult>` (or `EnsureAccountResult`) is a write, everything else is a read;
- it describes the **published contract**, which is what consumers actually see.

The check then enforces that every SDK method is either wrapped by a tool **of the matching kind** — writes by a `prepare_*` tool, reads by a read tool — or listed in `EXCLUDED_SDK_PATHS` with a reason. Covering a write with a read tool fails just as loudly as not covering it at all.

`npm run check:parity` prints the full report:

```
SDK surface: 25 methods (14 read, 11 write)
MCP tools:   23  ·  explicitly excluded: 2

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
