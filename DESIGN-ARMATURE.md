# `@trinaryex/sdk` — Armature (organizations & governance) module

**Status:** CYCLE 7 (2026-10-01) — ported to cycle-7 Armature (`armature` /
`armature_proposals` main, "Cycle 7 (#171)", fresh testnet publish). The governance
core now matches the type-keyed registry, permission bits, forward-only proposal
lifecycle and event-only single-PTB executions; every first-party proposal type and
every player/officer entry point is reachable (§13.2), with the exclusions written
down (§13.3). Phase F in §10 records the port. MCP parity for the new surface is
pending (done centrally). The original five phases completed 2026-09-11.
**Package:** `@trinaryex/sdk` (repo: `sdk/`) — the second module of the umbrella SDK, a
sibling to the trading surface described in [DESIGN.md](./DESIGN.md).
**Audience:** organization officers, treasurers, and bots acting **on behalf of an org**
rather than a personal wallet.
**Target:** **testnet only**, the **`stillness`** tenant. Scoped to the Armature behavior
`triex-app-api` actually wires today (see §13.3 for the deliberate exclusions).
**Sources of truth:** the Armature integration in `triex-app-api`
(`src/components/organizations/*`, `src/utils/orgNodes.ts`, `src/routes/api/v1/**`) and the
published gateway surface at `https://api.trinary.exchange/swagger.json`.
**Models after:** DESIGN.md §3–§5 — same `executor` pattern, same `queries`/`transactions`
split, same zod validation, same layering.

---

## 1. What this module is (and isn't)

Armature is the on-chain framework behind Trinary Exchange **organizations**: a tree of
OUs (organizational units — the top-level one is the "org"), each with its own board, its
own `EmergencyFreeze`, its own `TreasuryVault`, and a per-proposal-type governance config.
An org can own a `TradingAccount` and trade exactly like a player — except every write is
wrapped in a governance pipeline. (Cycle 7 renamed "DAO" to "OU" on-chain; SDK field names
that mirror the indexer wire — `daoId`, `subdaoControlCapId` — keep their spelling.)

The module gives an officer/bot one object to:

- **Read** org identity, membership trees, proposals, and shared-storage ACLs through
  `api.trinary.exchange` (the `etl-api` indexer), plus the governance state the indexer
  does not serve (live `ProposalConfig`, vote weights, treasury balances) from the fullnode.
- **Write** by building PTBs that route through `board_voting`, handed to the same
  caller-supplied `executor`.

### 1.1 Why this is not "trading, but for orgs"

The trading module is thin by nature: resolve some IDs → build a PTB → execute. Armature is
not. **The same action is a different transaction depending on who calls it.** Adding a
member is one atomic `submit_vote_execute` for an officer whose lone vote clears quorum, a
parent-DAO `ControllerBatchAddMembers` for someone seated one tier up, and a week-long
`submit_proposal` for anyone else. The choice depends on the caller's board seat, the
target DAO's live `proposal_configs`, and whether a `SubDAOControl` cap links the tiers.

`triex-app-api` already solved this once, in
`src/components/organizations/ouProposalHarness.ts`: a pure resolver that ranks four
strategies and returns the winner plus a human-readable reason.

> **Porting that resolver is the point of this module.** Without it we ship ~40 transaction
> builders and force every caller to reimplement the decision tree. With it,
> `org.members.add([...])` is one call that either executes or proposes and tells you which
> it did. The resolver is §7 and it is the load-bearing piece — everything else is plumbing
> around it.

### 1.2 Non-goals

- **No keyspace/ACL encryption.** That already ships as
  [`@trinaryex/keyspace`](https://www.npmjs.com/package/@trinaryex/keyspace) (`AclClient`,
  Seal session keys, storage adapters). This module wraps only the *discovery* read
  (`/v1/players/{address}/accessible-keyspaces`) and links out. Decryption belongs where
  the private key lives.
- **No metadata hosting.** Org create/update take an already-uploaded `metadataUri`
  (§11, OQ-A3). The app has a server route for the upload; the SDK does not.
- **No role taxonomy.** admin/officer/member is an explicitly temporary shim in the app
  (`src/utils/orgNodes.ts:111`). This module ships the node graph as primary (§5.1).
- ~~No unwired Armature surface.~~ **Superseded in cycle 7**: every first-party proposal
  type (currency, sub-OU lifecycle and control, freeze governance, upgrades, bypass) and
  every direct entry point a player or officer can call is wrapped. §13.3 now lists only
  what genuinely cannot be exposed, with the reason.
- **No custody.** Same as the trading module: signing is delegated to an `executor`.

---

## 2. Scope → endpoint / transaction map

Tagged **READ** (indexer or fullnode) or **WRITE** (on-chain PTB), mirroring DESIGN.md §2.
Every indexer route listed is already enabled on the gateway — there is no Phase-0
equivalent to do here (§13.1).

| # | User story | Plane | Indexer endpoint / Move entrypoint |
|---|---|---|---|
| A1 | Find the orgs I belong to | READ | `GET /v1/players/{address}/orgs` |
| A2 | Read one org and its full unit tree | READ | `GET /v1/orgs/{org_id}` (any unit id returns the root) |
| A3 | Batch-resolve org ids seen in fills/orderbooks | READ | `GET /v1/orgs?ids=` (≤200) |
| A4 | Browse orgs to join | READ | `GET /v1/orgs/directory` (cursor-paged) |
| A5 | Search orgs by name / org id / treasury id | READ | `GET /v1/search?orgs=true` |
| A6 | Whose balance manager is this? | READ | `GET /v1/balance-managers/owners` — already wrapped as `account.owners()`; the `ou:<org_id>` tag just needs documenting |
| A7 | List an org's proposals | READ | `GET /v1/orgs/{org_id}/proposals` (**discovery only** — no configs, no snapshot weight) |
| A8 | Hydrate one proposal for a vote decision | READ | **fullnode** — the live `Proposal` object: snapshot weight, votes cast, decoded payload, composite steps, wall-clock status |
| A9 | What can this org actually do? | READ | **fullnode** — the OU's `ou::TypeSlot` dynamic fields (one per enabled type), its root flags and its `EmergencyFreeze` |
| A10 | Which keyspaces can I reach? | READ | `GET /v1/players/{address}/accessible-keyspaces` |
| B1 | Create an organization | WRITE | `armature_proposals::tribe_setup::create_tribe_configured` (+ `vector<ou::ProposalTypeInit>` overrides) |
| B2 | Add / remove members, set a board | WRITE | `BatchAddMembers` / `BatchRemoveMembers` / `SetBoard`, or their `Controller*` forms via the parent |
| B3 | Update org name / metadata | WRITE | `UpdateMetadata` → `admin_ops::execute_update_metadata` |
| B4 | Enable a proposal type / change its rules | WRITE | `EnableProposalType` / `UpdateProposalConfig` |
| B5 | Vote, clean up, execute a passed proposal | WRITE | `board_voting::vote`, `proposal::delete_expired_proposal`, `board_voting::ticket_from_vote` (deletes the proposal) → domain `execute_*` |
| B6 | Bundle N actions into one proposal | WRITE | `composite::{new_frame, add_step, submit_composite}`; execution advances step-by-step |
| C1 | Fund the org treasury | WRITE | `treasury_vault::deposit<T>` — **permissionless**, no governance |
| C2 | Read treasury balances | READ | **fullnode** — `Balance<T>` dynamic fields (cycle 7 treasuries hold coins only) |
| C3 | Pay out of the treasury | WRITE | `SendCoin<T>` (to an address) / `SendCoinToOU<T>` (to another org) / `SendSmallPayment<T>` (rate-limited) |
| D1 | Give the org a trading account | WRITE | `SetupTradingAccount` → `trading_ops::execute_setup_trading_account` |
| D2 | Place / cancel an org limit order | WRITE | `PlaceLimitOrder<Q>` / `PlaceLimitOrderCoin<B,Q>`, `CancelOrder<Q>` / `CancelOrderCoin<B,Q>` |
| D3 | Buy using treasury funds | WRITE | composed PTB: `DepositCoinToBook<Q>` → `PlaceLimitOrder<Q>(isBid=true)` |
| D4 | Sell items held in shared storage | WRITE | composed PTB: `DepositFromDaoVaultToBook` → `PlaceLimitOrder<Q>(isBid=false)` |
| D5 | Sweep proceeds home | WRITE | `SweepCoinToTreasury<Q>` / `SweepMulticoinToTreasury` / `SweepMulticoinToDaoVault` |
| D6 | Sweep everything in one signature | WRITE | claim settled → park each item stack in its per-SSU vault → CRED to treasury |
| E1 | List shared storage at a hub | READ | `GET /v1/hubs/{hub_id}/dao-vaults` (vault + grant/revoke-netted ACL per role) |
| E2 | Resolve one org's vault at an SSU | READ | **fullnode** — `DaoReceiptVaultRegistry` keyed by `VaultKey { storage_unit_id, registrant_dao_id }` |
| E3 | Open shared storage for an org | WRITE | `dao_receipt_vault::initialize_dao_vault_v2` |
| E4 | Deposit / withdraw receipts | WRITE | `dao_receipt_vault::{deposit_receipt, withdraw_receipt}` |
| E5 | Grant / revoke vault access | WRITE | `dao_receipt_vault::{grant, grant_edit_ou, revoke}` |

**Not on the critical path but adjacent and currently unwrapped:** `GET /v1/stats` (carries
`StatsOrganizations` + `StatsTopOrg`) and `GET /v1/world/tribes/{tribe_id}` (game-world
factions, *distinct* from on-chain orgs — do not conflate the two in types or docs).

---

## 3. Architecture

The read plane is unchanged from DESIGN.md §3. The write plane gains a resolver stage
between "read state" and "build PTB" — that stage is the whole difference.

```
                    ┌──────────────────────────────────────────────────┐
   officer / bot    │              @trinaryex/sdk (armature)           │
   (owns Sui key) ──┤                                                  │
                    │  client.orgs.*        (identity, discovery)      │
                    │  client.org(id) ──►   OrgHandle                  │
                    │                        ├── governance            │
                    │                        ├── members / metadata    │
                    │                        ├── treasury              │
                    │                        ├── orders   (as the org) │
                    │                        └── vault    (shared SSU) │
                    │                                                  │
                    │  armature/queries.ts ──READ──► api.trinary.exchange
                    │  armature/governance.ts ─READ─► fullnode (DAO objects)
                    │                                                  │
                    │            ┌───────────────────────────┐         │
                    │  action ──►│ harness.ts  (PURE)        │         │
                    │            │  own-execute              │         │
                    │            │  control-execute          │──plan──►│
                    │            │  own-propose              │         │
                    │            │  control-propose          │         │
                    │            │  └ or BlockedPlan+reason  │         │
                    │            └───────────────────────────┘         │
                    │                        │                         │
                    │  armature/plan.ts ──build PTB──► executor(tx) ───┼──► Sui
                    └──────────────────────────────────────────────────┘
```

The resolver is deliberately free of the Sui runtime (`ouProposalHarness.ts` keeps the same
separation, and says so in its header comment): it takes plain data — board arrays, configs,
a caller address — and returns a strategy. `plan.ts` is the only place that turns a strategy
into a `Transaction`. That split is what makes the ladder exhaustively unit-testable, and it
is why §10 Phase B can land fully tested before a single transaction is signed.

---

## 4. Package layout

Additive; nothing in `src/*.ts` moves. Armature gets its own directory because it is a
second module, not an extension of the trading surface.

```
sdk/src/
├── armature/
│   ├── queries.ts       # indexer reads — the 8 org routes (§2)
│   ├── schemas.ts       # zod for OrgResponse / ProposalResponse / AccessibleKeyspace / HubDaoVault / …
│   ├── governance.ts    # fullnode (BCS): OU root, TypeSlot fields, freeze; PERMISSIONS; singleVoteExecutable
│   ├── proposals.ts     # fullnode: live Proposal hydration, capability vault, entries, frame steps
│   ├── executors.ts     # passed-proposal handlers, dispatched by payload Move type  [cycle 7]
│   ├── lifecycle.ts     # CreateSubOU/SpawnOU/SpinOut/TransferAssets, sub-OU control, freeze gov [cycle 7]
│   ├── currency.ts      # AdoptCurrency/MintCoin/MintAllowance/BurnCoin/ReturnCurrencyCap/bypass [cycle 7]
│   ├── upgrade.ts       # ProposeUpgrade (authorize → Upgrade → commit)            [cycle 7]
│   ├── create.ts        # tribe_setup::create_tribe_configured                      [cycle 7]
│   ├── OrgClientGroups.ts # org.currency / units / freeze / entries / upgrade / capabilities [cycle 7]
│   ├── tree.ts          # OrgResponse → node graph, seats, OuExecContext
│   ├── harness.ts       # PURE resolver: evaluatePaths / selectStrategy / canComposite
│   ├── plan.ts          # strategy → Transaction; composite submit; execute-passed; advance-step
│   ├── actions.ts       # OuProposalAction catalog, one factory per governance action (§13.2)
│   ├── transactions.ts  # raw PTB builders: framework + armature_proposals + create_tribe + treasury deposit
│   ├── trading.ts       # armature_trading builders (org-acting order flow)
│   ├── vault.ts         # DaoReceiptVault: registry resolve, balances, init/deposit/withdraw/grant/revoke
│   ├── bcs.ts           # VaultKey / MultiCoinBalance / Balance dynamic-field key encoders
│   └── types.ts         # Org, OrgNode, Seat, ProposalConfig, ExecutionPlan, RunOutcome, …
├── OrgClient.ts         # the OrgHandle returned by client.org(id)          [Phase B]
├── http.ts              # shared indexer GET + error mapping (see below)
├── config.ts            # (extended) armature package ids + registry ids — §9
├── index.ts             # (extended) re-exports
└── queries.ts           # (extended) IndexerClient gains `.orgs`
```

`http.ts` was not in the original sketch. `OrgQueries` needed the same
status→`TriexError` ladder `IndexerClient` already had, and the alternatives were
duplicating ~60 lines of error mapping or making the org module a subclass of the
trading one. Extracting `indexerGet()` keeps one ladder for both surfaces;
`IndexerClient.get` is now a one-line delegate, so existing behavior is unchanged
(the trading suite still passes untouched).

Toolchain, conventions, and build are unchanged (DESIGN.md §4). One note on tests: the
app's `ouProposalHarness.test.ts` (431 lines) and `governance.test.ts` (211 lines) cover
pure functions with no React and no Sui runtime — they port near-verbatim, so Phase B
arrives with 642 lines of behavioral coverage for free.

---

## 5. Public API design

### 5.1 Two entry points: the catalog and the handle

Org-level reads that need no acting identity hang off `client.orgs` (and mirror onto
`ReadOnlyClient.orgs`, since a dashboard needs all of them and none of the writes).

Everything that acts **as** an org goes through a handle:

```ts
const org = await client.org(orgIdOrAnyUnitId)
```

`client.org()` resolves the tree once (`GET /v1/orgs/{org_id}`), loads the governance state
for the seat and its parent, caches both, and picks the caller's default seat. This exists
because the alternative is threading `daoId`, `parentDaoId`, `capVaultId`, `controlCapId`,
`emergencyFreezeId` and `treasuryVaultId` through every single method — which is exactly
what the app's `buildTribal*Tx` signatures do, and exactly why they are unpleasant to call.

**A seat is a board you actually sit on**, addressed by DAO id:

```ts
org.seats           // OrgSeat[], highest-authority first
org.seat            // the acting seat (default = highest authority)
org.as(daoId)       // a handle bound to a different seat you hold
```

Seats carry `roleKey` / `roleLabel` / `rank` from the node graph rather than a hardcoded
admin/officer/member enum, so a governance-defined role model does not break the surface
later. This is the app's `getSeatNodes` / `resolveActingSeat` model, ported.

### 5.2 Methods → user stories

```ts
// ── catalog: identity & discovery (also on ReadOnlyClient) ──────────────────
client.orgs.get(orgId): Promise<Org>                                   // A2
client.orgs.batch(orgIds): Promise<Org[]>                              // A3  ≤200
client.orgs.directory(params?): Promise<OrgDirectoryPage>              // A4  cursor-paged
client.orgs.forPlayer(address?): Promise<Org[]>                        // A1
client.orgs.search(q, opts?): Promise<OrgSearchResult[]>               // A5
client.orgs.proposals(orgId): Promise<ProposalSummary[]>               // A7  discovery only
client.orgs.accessibleKeyspaces(address?, role?): Promise<AccessibleKeyspace[]>  // A10
client.orgs.create(params): Promise<{ orgId, tx: TxResult }>           // B1

// ── handle: governance ──────────────────────────────────────────────────────
org.governance.read(): Promise<DaoGovernance>                          // A9  enabled + configs + bindings
org.governance.resolve(action): ExecutionPlan | BlockedPlan            // §7 — decide, do NOT sign
org.governance.paths(action): PathCandidate[]                          // §7 — the full trace
org.governance.run(action): Promise<RunOutcome>                        // build → execute
org.governance.runBatch(actions): Promise<RunOutcome>                  // N actions, one strategy, one signature
org.governance.runComposite(actions): Promise<RunOutcome>              // B6  one Proposal<CompositePayload>
org.governance.canComposite(actions): CompositeEligibility
org.governance.proposal(proposalId): Promise<Proposal>                 // A8  fullnode hydration
org.governance.vote({ proposalId, approve }): Promise<TxResult>        // B5
org.governance.execute(proposalId): Promise<TxResult>                  // B5  ticket_from_vote → execute_*
org.governance.advanceComposite(proposalId): Promise<TxResult>         // B6
org.governance.deleteExpired({ proposalIds }): Promise<TxResult>      // cycle 7 (was tryExpire)

// ── handle: membership & identity ───────────────────────────────────────────
org.members.add(addresses): Promise<RunOutcome>                        // B2
org.members.remove(addresses): Promise<RunOutcome>                     // B2
org.members.setBoard({ add?, remove? }): Promise<RunOutcome>          // B2  a diff since cycle 7
org.metadata.update({ name?, metadataUri }): Promise<RunOutcome>       // B3

// ── handle: proposal-type administration ────────────────────────────────────
org.types.enable(typeKey, moveType, config?): Promise<RunOutcome>      // B4
org.types.updateConfig(typeKey, patch): Promise<RunOutcome>            // B4  every field optional
org.types.enableTrading(opts?): Promise<RunOutcome>                    // D1 prerequisite
org.types.enableSendCoin(coinType): Promise<RunOutcome>                // C3 prerequisite (per-coin key)
org.types.enableComposite(): Promise<RunOutcome>                       // B6 prerequisite

// ── handle: treasury ────────────────────────────────────────────────────────
org.treasury.balances(): Promise<TreasuryBalances>                     // C2  fullnode
org.treasury.deposit({ coinType, amount }): Promise<TxResult>          // C1  permissionless, no governance
org.treasury.send({ coinType, amount, to }): Promise<RunOutcome>       // C3
org.treasury.sendToOrg({ recipientTreasuryId, amount, coinType? })   // C3  SendCoinToOU<T>

// ── handle: trading as the org (mirrors client.orders / client.account) ─────
org.orders.ensureAccount(): Promise<RunOutcome>                        // D1
org.orders.limit({ storageUnitId, assetId, side, price, quantity, expireAt? })  // D2
org.orders.cancel({ storageUnitId, assetId, orderId })                 // D2
org.orders.buyFromTreasury({ ...limit, depositAmount? })               // D3  deficit-only by default
org.orders.sellFromDaoVault({ ...limit, vaultQuantity? })              // D4
org.orders.sweep({ pools?, items?, cred? })                            // D5
org.orders.sweepAll(): Promise<RunOutcome>                             // D6  claim + park + treasury, one PTB
org.orders.openOrders() / fills() / trades() / sweepable()             // reuse the trading module, org BM id

// ── cycle 7 additions (every governance write takes opts?: { unitId?, metadataIpfs? }) ──
client.orgs.create(params) / createStandalone(params)                  // B1  tribe_setup / ou::create
org.governance.proposal(id): Promise<LiveProposal | null>              // A8  live object (null = deleted)
org.governance.deleteExpired({ proposalIds })                          // permissionless cleanup
org.governance.expired() / deleteExhaustedFrame(frameId)
org.governance.execute(id, { freezeAdminCapId?, treasuryCapId?, upgrade?, deleteFrame? })
org.types.disable(key) / enableSendCoinToOrg() / enableSendSmallPayment()
org.treasury.sendSmall() / claim()
org.currency.enable/adopt/mint/mintAllowance/configureAllowance/mintWithAllowance/burn/returnCap
org.units.create/pause/unpause/transferCap/reclaimCap/spinOut/spawnSuccessor/transferAssets/destroy
org.freeze.read/freezeType/unfreezeType/unfreeze/setMaxDuration/updateExempt/transferAdmin
org.entries.list/publish/update/edit/rotateEpoch/remove                // member-gated, no vote
org.upgrade.propose(...)
org.capabilities.list/enableBypass/disableBypass

// ── handle: shared storage (DaoReceiptVault) ────────────────────────────────
org.vault.atHub(hubId): Promise<HubDaoVault[]>                         // E1  indexer
org.vault.resolve({ storageUnitId }): Promise<string | null>           // E2  registry lookup
org.vault.balances(vaultId): Promise<AssetBalance[]>                   // fullnode
org.vault.init({ storageUnitId, editorDaoId? }): Promise<TxResult>     // E3
org.vault.deposit({ storageUnitId, items }) / withdraw({ ... })        // E4
org.vault.grant({ vaultId, role, principal }) / revoke({ ... })        // E5
org.vault.deinit({ vaultId })
```

**`RunOutcome` is the module's characteristic return type.** A governance write does not
have one shape, so it must not pretend to:

```ts
type RunOutcome =
  | { status: 'executed'; digest: string }
  | { status: 'proposed'; digest: string; proposalId?: string }
  | { status: 'blocked';  code: BlockCode; reason: string }
```

Callers branch on `status`. `blocked` is a returned value, not a thrown error, because "you
are not on this board" is an ordinary answer to "can I do this?" — the same reason
`resolve()` exists as a dry-run. Genuine failures (transport, on-chain abort, schema drift)
still throw `TriexClientError` exactly as in the trading module.

`proposalId` comes from the transaction's created objects, never a follow-up indexer read
(§12).

---

## 6. On-chain transaction builders

All pure `(args) => Transaction` (or `(tx, args) => TxArg` for fragments composed into a
larger PTB), same contract as DESIGN.md §6. Confirmed against `triex-app-api`
`src/components/organizations/txBuilders.ts` (2,499 lines) and the `armature_vault` /
`armature_trading` packages.

### 6.1 Framework (`armature`) — `armature/transactions.ts`

| Builder | Move target | Notes |
|---|---|---|
| `submitVoteExecute` | `board_voting::submit_vote_execute[_readonly]<P>(ou, metadata_ipfs, payload, freeze, clock)` | No `type_key` (cycle 7): `P` selects the slot. Creates **no** `Proposal` — the id is minted from the tx context, events are the audit trail. `_readonly` (cooldown-0 types) takes `&OU`, so the OU is an immutable input and concurrent single-vote executions stop contending on it |
| `submitProposal` | `board_voting::submit_proposal<P>(ou, metadata_ipfs, payload, clock)` | The only path that shares a `Proposal<P>` |
| `ticketFromVote` | `board_voting::ticket_from_vote[_readonly]<P>(ou, proposal, freeze, clock)` | Takes the proposal **by value and deletes it**; rebate to the gas payer; executor must be a CURRENT member; aborts after `passed_at + delay + expiry` |
| `voteTx` | `board_voting::vote<P>(proposal, ou, approve, clock)` | Moved from `proposal::vote`; voters are the members at the proposal's snapshot roster version |
| `appendDeleteExpiredProposal` / `deleteExpiredProposalTx` | `proposal::delete_expired_proposal<P>(proposal, clock)` | Replaces `try_expire`. Permissionless; Active past `created + expiry`, or Passed past its execution window |
| `newConfig` | `proposal::new_config` + `with_composable_allowed` / `with_permissions` / `with_borrow_scope` | Chains whichever the input sets |
| `typeNameOf` / `typeNameVec` | `ou::type_name_of<T>()` (+ `MakeMoveVec<TypeName>`) | `TypeName` cannot cross as pure |
| `newTypeInit` / `typeInitVec` / `initBoard` | `ou::new_type_init<T>`, `governance::init_board` | Construction-time slots / board init |
| `newFrame` / `addStep` / `submitComposite` | `composite::{new_frame, add_step<P> / add_enable_proposal_type_step / add_update_proposal_config_step, submit_composite}` | `addStep` picks the typed entry for the two grant-capable types |
| `beginPipeline` / `advanceStep` / `finalizePipeline` / `appendDeleteExhaustedFrame` | `composite::*` | Execution pipeline; frame cleanup is permissionless |
| `freezeTypeTx` / `unfreezeTypeTx` | `emergency::{freeze_type<P>, unfreeze_type<P>}` | `FreezeAdminCap` holder, no vote; keyed by Move type |
| `publishEntryTx` … `removeEntryTx` | `encrypted_entry::*` | Member-gated by design, no vote, no bit |
| `createOuTx` / `destroyOuTx` | `ou::{create, destroy}` | Standalone OU; permissionless cleanup of a migrating one |
| `depositToTreasuryTx` / `claimTreasuryCoinsTx` (treasury.ts) | `treasury_vault::{deposit<T>, claim_coin<T>}` | Permissionless |
| `createTribeTx` (create.ts) | `armature_proposals::tribe_setup::create_tribe_configured` | Enables the controller types with their bits on root + officers |

> `<P>` is the payload Move type, and since cycle 7 it is the WHOLE contract: the OU's
> registry is keyed by `TypeName` (`with_defining_ids`), so there is no `type_key` to get
> wrong and no binding map — the display key (`SetBoard`, `CharterUpdate`,
> `SendCoin<…>`) is a label the chain records. The SDK therefore looks configs up by
> Move type (`slotForType`), mapping `current → original` package ids first, and falls
> back to the display key only for a read that carries no slots.

### 6.2 Governance actions — `actions.ts`, `treasury.ts`, `lifecycle.ts`, `currency.ts`, `upgrade.ts`

Not raw builders: each is an `OuProposalAction` carrying an `own` adapter (payload +
`execute_*`) and/or a `control` adapter the parent uses via its `SubOUControl`. Adapters
declare the permission bits / borrow scope their handler needs (`requiredPermissions`,
`requiredBorrowScope`) so the resolver can refuse a type that would abort with
`EPermissionDenied`. Full catalog in §13.2. Executing a PASSED proposal dispatches on
its payload type (`executors.ts`: `executorForPayload`), reading objects named in the
payload (a target treasury, a child unit) from the live object.

### 6.3 Trading (`armature_trading`) — `armature/trading.ts`

Each is a governance-wrapped counterpart of a personal-trading builder from DESIGN.md §6:
payload `new` → `submit_vote_execute` → `trading_ops::execute_*`.

| Builder | Payload type | Notes |
|---|---|---|
| `setupTradingAccount` | `setup_trading_account::SetupTradingAccount` | Creates the org BM; stored on the trading node |
| `depositCoinToBook` | `deposit_coin_to_book::DepositCoinToBook<Q>` | Treasury → BM quote funding |
| `depositMulticoinToBook` | `deposit_multicoin_to_book::DepositMulticoinToBook` | Treasury items → BM |
| `depositFromDaoVaultToBook` | `deposit_from_dao_vault_to_book::DepositFromDaoVaultToBook` | Shared storage → BM |
| `placeLimitOrder` | `place_limit_order::PlaceLimitOrder<Q>` | Item↔CRED (`multicoin_pool`) |
| `placeLimitOrderCoin` | `place_limit_order_coin::PlaceLimitOrderCoin<B,Q>` | Coin pools |
| `cancelOrder` / `cancelOrderCoin` | `cancel_order::CancelOrder<Q>` / `cancel_order_coin::CancelOrderCoin<B,Q>` | |
| `sweepCoinToTreasury` | `sweep_coin_to_treasury::SweepCoinToTreasury<Q>` | BM CRED → treasury |
| `sweepMulticoinToTreasury` | `sweep_multicoin_to_treasury::SweepMulticoinToTreasury` | BM items → treasury |
| `sweepMulticoinToDaoVault` | `sweep_multicoin_to_dao_vault::SweepMulticoinToDaoVault` | BM items → shared storage |

**Composed PTBs** (the ones worth having as first-class methods, all ported from the app):

- `buyFromTreasury` — `DepositCoinToBook` then `PlaceLimitOrder(isBid=true)`. Deposit only
  the shortfall (required quote − current BM quote balance); if placement aborts, PTB
  semantics roll the deposit back.
- `sellFromDaoVault` — `DepositFromDaoVaultToBook` then `PlaceLimitOrder(isBid=false)`.
  `vaultQuantity` is separate from `quantity` precisely because the BM may already hold
  part of the stack.
- `sweepAll` — claim settled per pool → park each item stack in its resolved per-SSU
  `DaoReceiptVault` → aggregate CRED to the treasury. One signature. Item stacks whose vault
  does not resolve must be **reported as skipped**, never silently dropped.

`armature_trading` also ships `place_market_order.move`, which the app never wires — §13.3.

### 6.4 Shared storage (`armature_vault`) — `armature/vault.ts`

| Builder | Move target | Notes |
|---|---|---|
| `initializeDaoVault` | `dao_receipt_vault::initialize_dao_vault_v2` | Registry + SSU + registrant DAO + vault config + three principal vectors |
| `depositReceipt` / `withdrawReceipt` | `dao_receipt_vault::{deposit_receipt, withdraw_receipt}` | |
| `grant` / `grantEditOu` / `revoke` | `dao_receipt_vault::{grant, grant_edit_ou, revoke}` | Roles: `deposit` / `withdraw` / `edit` |
| `updateRegistryKey` / `deinitializeDaoVault` | `dao_receipt_vault::{update_registry_key, deinitialize_dao_vault}` | |

> **`Principal` cannot cross as `tx.pure()`.** It is a Move enum (`copy, drop, store`), so a
> `vector<Principal>` must be assembled inside the PTB: call `acl::ou(id)` or
> `acl::player(addr)` per element, then `tx.makeMoveVec({ type: '${armatureVault}::acl::Principal', … })`.
> The app hits this at `OrgVaultPanel.tsx:274`. Ship
> `principalVec(tx, principals)` as a helper so no caller ever meets this.

Editor semantics from the app: a tier's vault is governed by the tier **above** it — admin
and officer vaults are edited by the root DAO, the member vault by the officers DAO.
`init()` should default `editorDaoId` that way rather than making every caller decide.

---

## 7. The resolver (`armature/harness.ts`) — the load-bearing piece

Pure, no Sui runtime, no I/O. Inputs: the action, the seat's execution context (own board +
`EmergencyFreeze` + optional parent linkage), the relevant on-chain configs, and the caller
address. Output: a ranked list of candidates and a winner.

**Four strategies, in priority order:**

| Strategy | Tier | What it does |
|---|---|---|
| `own-execute` | immediate | `submit_vote_execute` on the seat's own DAO — one transaction |
| `control-execute` | immediate | Parent `submit_vote_execute` of a `Control*` payload, applied to this child |
| `own-propose` | slow | `submit_proposal` on the seat's own DAO |
| `control-propose` | slow | Parent `submit_proposal` of a `Control*` payload |

**The single-vote predicate** is the crux, and it is not "is the caller an admin":

```
singleVoteExecutable(boardSize, config) =
    boardSize > 0
 && config.executionDelayMs === 0        // atomic execute is asserted on-chain
 && boardSize * config.quorum <= 10_000  // weight-1 voting: one vote is 1/N of total
```

Board voting is weight-1 per member, so a lone vote clears quorum iff `1 × 10000 ≥ N ×
quorum`. The approval threshold is always satisfied by a single 100%-yes vote, so quorum is
the only gate. This is why **a five-member board with a 5000bps quorum cannot single-vote
anything** while a five-member board with a 1bps quorum can — and why per-type configs, not
roles, decide.

**Blocking is a value, not an exception.** `BlockCode` is `not-member` | `needs-slow-tier` |
`not-permitted`. An action may set `fallbackPolicy: 'single-vote-only'` to refuse degrading
into a slow proposal (the app uses this where a deferred proposal would be surprising).

**Cycle 7 gates.** The ladder now also models the on-chain checks that would otherwise
surface as an abort after signing — each as a per-candidate `blocker`:

| Gate | Source | Effect |
|---|---|---|
| Permission bits / borrow scope | slot `config.permissions` / `borrow_scope` vs the adapter's `requiredPermissions` / `requiredBorrowScope` | BOTH tiers non-viable (`missing-permissions`) — a proposal that can never execute is not offered |
| Pause / migration | OU root `execution_paused`, `controller_paused`, `status` | immediate tier only (`paused`); a migrating OU runs only `TransferAssets` |
| Freeze | `EmergencyFreeze.frozen_types`, keyed by Move type | immediate tier only (`frozen`) |
| Cooldown | slot `last_executed_ms + cooldown_ms` | immediate tier only (`cooldown`) |
| Propose threshold | `propose_threshold > 1` (board weight is 1) | both tiers (`not-permitted`) |

Board size comes from the OU root's `member_count` and membership from the roster table
(`fetchIsBoardMember`) when available — both head-current — instead of the lagging
indexer. A winning immediate strategy carries `readonly: true` when the type's cooldown
is 0, and `plan.ts` then uses `submit_vote_execute_readonly`. When several gates apply,
the block code names the most actionable (`missing-permissions` > `paused` > `frozen` >
`cooldown` > `needs-slow-tier` > `not-permitted`).

`privileged_submit` is NOT a strategy: it needs a `&SubOUControl`, which only a handler
holding the loaned cap can produce, so the control strategies reach it through the
`subou_ops` / `lifecycle_ops` handlers. Methods that act ON a unit take `unitId`, so a
parent's board can act on a child it does not sit on (`OrgHandle.contextFor`).

**`evaluatePaths()` returns every candidate with a reason**, viable or not, and
`selectStrategy()` picks the first viable one from that same list. They are separate
functions over one array specifically so a trace can never disagree with the decision —
worth preserving in the port, and worth exposing as `org.governance.paths(action)` so a bot
can log *why* it ended up proposing.

**Composite eligibility** (`canComposite`) is a batch concern, not a fifth strategy: a cart
of same-tier `own-propose` actions collapses into one `Proposal<CompositePayload>` when the
unit has the `Composite` slot (a DEFAULT since cycle 7), every step type is
`composable_allowed`, no step grants permission bits (`EGrantInComposite`), and there
are ≤16 steps (`MAX_COMPOSITE_STEPS`, mirroring `composite.move`). There is no
control-composite — composites run only against a DAO's own pipeline, so every action needs
an `own` adapter.

---

## 8. On-chain reads the indexer cannot serve

Underestimating this section is the main way this module goes over schedule: it is more code
than the HTTP layer and has no swagger to check against.

| Module | Reads | Why not the indexer |
|---|---|---|
| `governance.ts` | OU root (BCS: status, pause flags, `member_count`, roster table id, companion ids), every `ou::TypeSlot` dynamic field (BCS: display key, `ProposalConfig` incl. bits + scope, `last_executed_ms`), the `EmergencyFreeze` (BCS) | Cycle 7 moved the registry off the root into one dynamic field per type; the resolver needs it head-current |
| `proposals.ts` | Live `Proposal<P>` (JSON — `P` sits mid-struct, so no BCS), capability vault (BCS), encrypted entries (BCS), composite frame step payloads | The indexer now carries each proposal's slot config at creation, but not snapshot weight or votes; an executed/expired proposal no longer exists on-chain at all |
| `vault.ts` | `DaoReceiptVaultRegistry` → `Table<VaultKey, ID>` dynamic field; per-asset vault balances | Registry lookup is a BCS-keyed dynamic field; `/v1/hubs/{id}/dao-vaults` gives ACLs, not balances |
| `treasury.ts` | `Balance<T>` dynamic fields on the `TreasuryVault` (coins only since cycle 7) | No treasury-balance route exists |

**Transport shape gotcha, and it bites every parser here:** Move structs cross in two
shapes — gRPC proto-JSON exposes fields directly (`{ contents: [...] }`), JSON-RPC nests
them under `.fields`. The app's `asRecord()` unwraps the `.fields` layer when present so
both parse identically. Port that helper first and route every parser through it.

**Original vs current package id:** dynamic-field key types and `StructType` filters must use
the **original** package id (objects keep the type tag of the package version that created
them), while `moveCall` targets use the **current** one. On `stillness`,
`armature_trading` and `armature_vault` have already diverged (§9), so this is live today,
not hypothetical.

---

## 9. Configuration & package IDs

`PackageIds` carries flat `{ current, original }` siblings per Armature package (D-A6):

```ts
armature, armatureOriginal
armatureProposals, armatureProposalsOriginal
armatureTrading, armatureTradingOriginal
armatureVault, armatureVaultOriginal
ouReceiptVaultRegistry                            // shared object, not a package
```

**Cycle 7 is a fresh publish** (`Published.toml` → `testnet_stillness`): every
`*Original` equals its id today, so the current/original split is dormant — but the
resolver still maps `current → original` before matching slot types
(`OrgHandle.aliases()` → `slotForType`), because a slot is keyed by the DEFINING id and
the first upgrade would otherwise silently miss every config. `armature_world_bridge` is
no longer configured (the app dropped it); its `AutojoinOU` self-join is excluded (§13.3).

Option 2 (a `PackageRef` object) stays rejected for the reasons recorded at Phase A:
`${ids.armature}::board_voting::…` is what nearly every builder writes.

## 10. Phasing

Independent of the trading module's Phase 0–4 (all complete). No gateway enablement phase is
needed: every org route in §2 is already live (§13.1).

- **Phase A — Reads.** `config.ts` extension, `armature/schemas.ts`, `armature/queries.ts`,
  `armature/tree.ts`. Lands on `ReadOnlyClient.orgs.*`. Unblocks dashboards and MCP read
  tools immediately at zero signing risk, and forces the type model (nodes, seats, roles)
  to settle before anything depends on it.
- **Phase B — Governance core. ✅ DONE 2026-09-11.** `armature/governance.ts` (parsers +
  `singleVoteExecutable` + fullnode reads), `armature/harness.ts` (the four-strategy
  resolver + composite eligibility, pure), `armature/transactions.ts` (framework
  primitives), `armature/plan.ts` (strategy → PTB, composite submit/execute,
  execute-passed), `armature/actions.ts` (the catalog + config presets), and
  `armature/OrgClient.ts` — the `OrgHandle` behind `client.org(id)`, carrying
  `governance` / `members` / `metadata` / `types`. 80 new tests; 250 total green.

  Two items scoped INTO Phase B by §2 are deferred, and neither blocks Phase C:
  **`orgs.create()` (B1)** — `create_tribe_configured` plus its `VecMap` bootstrap is a
  self-contained ~150-line builder that shares nothing with the resolver; and
  **`proposals.ts` full on-chain hydration (A8)** — `vote()`/`execute()` turned out to need
  only the indexer's `payloadType` + `typeKey`, so the fullnode read is now purely a
  vote-decision aid (snapshot weight, votes cast) rather than a prerequisite.
- **Phase C — Treasury & trading. ✅ DONE 2026-09-11.** `armature/treasury.ts` (coin +
  item balance reads, permissionless deposit, `SendCoin` / `SendCoinToDAO` actions) and
  `armature/trading.ts` (the seven `armature_trading` actions + the permissionless
  claim-settled fragment), surfaced as `org.treasury.*` and `org.orders.*`. Composed flows
  — `buyFromTreasury`, `sellFromDaoVault`, and the claim-then-sweep pair — build as ONE
  PTB via the new `appendPlanActions`, so ordering is explicit and the funding guarantee
  holds. 31 new tests; 281 total green.

  **Trading actions are `single-vote-only`, and that is a design choice worth knowing.** A
  limit order that degrades into a week-long proposal is not a slower order, it is a wrong
  one — priced against a book that no longer exists. Worse, a funded buy split into two
  independent proposals loses the atomic deposit-then-place guarantee entirely. Blocking is
  the honest outcome; `TRADING_TYPE_CONFIG`'s quorum of 1 is what normally prevents it from
  arising.

  Deferred from C, consistent with DESIGN.md OQ-5 (coin-pools out of scope for the trading
  module): the **coin-pool order variants** (`PlaceLimitOrderCoin` / `CancelOrderCoin`).
  `enableTrading({ bindToBaseType })` already registers their type keys; only the order
  builders are missing. `sweepAll` (D6) and vault RESOLUTION for `sellFromDaoVault` /
  `sweepItems` land in Phase D — both take an explicit `daoVaultId` today, which
  `orgs.vaultsAtHub()` supplies.
- **Phase D — Shared storage. ✅ DONE 2026-09-11.** `armature/vault.ts` — registry
  resolution, vault info + balance reads, the six write builders, the `Principal`/`Role`
  vector helpers, and wallet-receipt sourcing — surfaced as `org.vault.*`, plus
  `orders.sweepAll()`. `sellFromDaoVault` and `sweepItems` now RESOLVE the vault instead of
  demanding a raw id. 28 new tests; 309 total green. (No separate `bcs.ts`: `VaultKeyBcs`
  and the balance decoders live next to their only callers rather than in a shared module
  nothing else imports.)

  Three things the chain forced into the API shape, each worth knowing before calling it:

  - **A vault is keyed by (storage unit, organization), never by storage unit alone.**
    Anyone may register a vault at any SSU, so resolving by hub would cheerfully return a
    stranger's. `vault.resolve()` defaults the registrant to the acting seat and then walks
    the rest of the tree — an org commonly registers on its officers unit while an admin
    acts from the root — and the not-found message names both halves.
  - **`init()` defaults EDIT to the parent unit.** A unit that governs its own access
    control can quietly widen it, so the tier above holds the key; a root unit falls back to
    itself because it has no alternative. The chain separately rejects an all-`player` edit
    set, since a vault whose only editors were bare keys could be bricked beyond recovery.
  - **`sweepAll` reports what it could not park.** Item stacks with no resolvable vault come
    back in `skipped` rather than being dropped — a sweep that moved nine of ten stacks and
    returned success would be worse than one that moved none. The manifest carries no
    top-level currency figure, so the CRED leg is the balance manager's live holding plus
    the settled amounts the claims in that same PTB are about to add.
- **Phase E — MCP parity + docs. ✅ DONE 2026-09-11.** 47 Armature tools (18 read, 29
  prepare) in `mcp/src/tools/org.ts` and `orgPrepare.ts`, 13 exclusions with written
  reasons, README sections in both packages, 10 new MCP tests (121 total). The gate reports
  lock-step against the real surface for the first time.

  **The gate had been grading a stale answer sheet.** `mcp/` depends on a PUBLISHED
  `@trinaryex/sdk`, so four phases of work were invisible to it — it reported "lock-step"
  against 3.8.0, a version predating the entire module. `npm run link:sdk` copies the
  sibling build in so local checks tell the truth; `npm install` restores the published
  copy. Without that, Phase E would have been written against a surface that did not exist.

  **Three tools were deliberately not written**, and the reasons are in
  `EXCLUDED_SDK_PATHS`: `governance.run` / `runBatch` / `runComposite` (plus `resolve`,
  `paths`, `canComposite`) take an `OuProposalAction` carrying `buildPayload` /
  `buildExecute` CLOSURES. That cannot cross a JSON boundary, and faking it with a string
  enum would just be the typed tools under a worse name — the typed `prepare_org_*` tools
  ARE that surface, each building an action internally.

  Fixing the gate turned up two more of its own blind spots, both first triggered by this
  module: an ARRAY parameter (`addresses: string[]`) was expanded as though
  `Array.prototype` were a bag of named options, drowning any real finding in forty
  spurious ones; and `sweepAll`'s `RunOutcome & { skipped }` classified as a READ because
  the write check matched the type text exactly rather than structurally — which would have
  let a read tool cover a write.

> The parity test walks the SDK's public client surface and fails on anything neither
> wrapped by a tool nor listed in `EXCLUDED_SDK_PATHS`. Every phase therefore needs either a
> tool or a written-down reason — a useful forcing function, and the reason Phase E cannot
> be deferred indefinitely.
>
> **It was not actually watching.** The scan walked one declaration file against a hardcoded
> class allowlist, so a namespace living in its own module was invisible: `client.orgs` (12
> read methods) landed and the gate still reported "lock-step". Fixed in Phase A —
> `sdk-surface.mjs` now roots external namespace modules too.
>
> Phase D needed NO gate change — `org.vault` was discovered automatically the moment it
> was added to the handle, which is the auto-discovery paying for itself one phase later.
> The surface now reports 56 methods (31 write, 25 read).
>
> Phase C widened it once more, and then stopped patching it. `OrgTreasuryApi` and
> `OrgOrdersApi` were invisible the moment they landed — the third recurrence of one bug,
> because a hardcoded class allowlist fails OPEN for a surface that grows. The gate now
> DISCOVERS a handle's groups from `OrgHandle`'s own property declarations
> (`HANDLE_ROOTS`), so adding a group to the handle is all it takes; the Armature surface
> reports 45 methods (25 write, 20 read) with nothing to remember.
>
> Phase B widened it twice more. The handle's sub-APIs are reached as
> `client.org(id).members.add(...)`, which does not match the gate's
> `client.<namespace>.<method>` shape, so all 15 governance writes were invisible for the
> same reason — they are now registered as `org.governance` / `org.members` /
> `org.metadata` / `org.types`. And `RunOutcome` had to join `WRITE_RETURN_TYPES`:
> without it every governance write classified as a READ, and the gate's "a write must be
> wrapped by a prepare tool" rule would have happily accepted a read tool over
> `org.members.add`. The Armature surface now reports 32 methods (15 write, 17 read).
> The gate stays green against the installed SDK (3.8.0, which predates the module) and
> goes red the moment a version carrying it is installed.

- **Phase F — Cycle 7 port. ✅ DONE 2026-10-01.** Ported against armature `main`
  ("Cycle 7 (#171)") and triex-app-api `main` (diffed from `d2bf307`). What changed, by
  layer:

  - *Reads.* The registry is per-type dynamic fields keyed by Move type; governance is
    read as OU root + slots + freeze, all BCS. Configs carry `permissions` and
    `borrowScope`. Live proposal hydration (A8) landed — and returns null for an
    executed/expired proposal, which cycle 7 deletes. Indexer schemas gained
    `config` / `created_ms` / `metadata_ipfs`, `machine_grant`, `machine` principals.
  - *Builders.* No `type_key` anywhere; `board_voting::vote` (takes the OU);
    `delete_expired_proposal` replaces `try_expire`; `_readonly` entry points; typed
    composite steps; `CompositePayload` in `composite_payload`; framework types moved
    from `armature_proposals` into `armature`; `SetBoard` is a diff; controller handlers
    lost their clock; `SendCoinToDAO` → `SendCoinToOU`; multicoin treasury reads removed.
  - *Resolver.* Permission bits / scope, pause, freeze, cooldown, propose threshold,
    chain-current board size and membership (§7); `runBatch` validates that every action
    agrees on the strategy (OQ-A11 ruled (1)).
  - *Surface.* Every first-party type and direct entry point is wrapped (§13.2): org
    creation, currency, sub-unit lifecycle and control, freeze (cap holder + governance),
    encrypted entries, upgrades, bypass opt-in/out, capability reads, small payments,
    coin claims, expired-proposal and frame cleanup.

---

## 11. Decisions & open questions

### Decided here

- **D-A1 — The resolver ports, not just the builders.** §1.1. Without it the module is a
  pile of PTB constructors and the decision logic gets reimplemented per caller.
- **D-A2 — Blocked is a value.** `RunOutcome.status === 'blocked'`, plus a dry-run
  `resolve()`. Permission state is an answer, not an exception (§5.2).
- **D-A3 — Node graph over role enum.** Seats carry `roleKey`/`rank`; no admin/officer/member
  union in the public types (§5.1). The app calls its own flat shim temporary; do not
  re-export a temporary shape into a published package.
- **D-A4 — Keyspace stays in `@trinaryex/keyspace`.** Wrap only the discovery read (§1.2).
- **D-A5 — `place_market_order` and friends stay out** until the app wires them (§13.3).
- **D-A6 — OQ-A1 resolved: flat sibling package-id fields** (`armature` /
  `armatureOriginal`). Rationale in §9.
- **D-A8 — `RunOutcome` returns `blocked`; it does not throw.** Implemented as designed
  (D-A2), and the handle proves out the reason: a blocked result is a fact about the org's
  shape or state (a slot lacking its permission bits, a paused unit, an active cooldown)
  rather than a caller error. Genuine failures still throw. (Cycle 6's example — removal
  on a root unit blocking because it was control-only — no longer holds: cycle 7 gives
  every unit its own `BatchRemoveMembers`.) The handle also refreshes its cached chain
  state after every successful governance write.
- **D-A9 — The handle caches governance per DAO id, for its own lifetime.** `resolve()` and
  `run()` each need the acting unit's config AND its parent's; a bot resolving twenty
  actions against one seat should not read the same two objects forty times. Scoping the
  cache to the handle means re-opening picks up a config change, and `refresh()` forces it.
- **D-A10 — `as(daoId)` throws for a seat the caller does not hold, while the DEFAULT seat
  falls back.** Different acts: naming a seat is a claim, and silently acting through a
  different one is worse than failing; not naming one is a request for the best available.
- **D-A14 — A governance prepare tool reports an OUTCOME, not just bytes.**
  `intent.outcome` is `executed` or `proposed`, and a blocked resolution returns
  `prepared: false` with the resolver's reason and code. A caller that assumed bytes meant
  "done" would sign a proposal and believe the thing had happened.
- **D-A13 — `@internal` is a doc convention the parity gate cannot see.**
  `OrgVaultApi.requireVaultId` was marked internal but declared public, so it landed in the
  MCP surface as a method a tool was expected to wrap. Genuinely-internal helpers that
  cannot be `private` (because another group calls them) are module-level functions taking
  the handle, not public methods with a tag.
- **D-A11 — Depositing to a treasury is permissionless, and the API says so.**
  `treasury.deposit()` returns a plain `TxResult`, not a `RunOutcome`, takes no seat, and
  falls back to the ROOT treasury when the caller holds no seat at all. Paying out returns
  `RunOutcome` because it is governance. The asymmetry in the return types is the
  authorization model made visible.
- **D-A12 — A `Promise`-returning method must never throw synchronously.** Hit three times
  now (`OrgsApi.forPlayer` in A; seven treasury/metadata methods in C). Validation and
  `require*()` calls run before the first `await`, so without `async` the error escapes the
  caller's `.catch()`. Every Promise-returning method that can reject is `async`.
- **D-A7 — Optional wire fields become optional KEYS.** A zod `.transform()` infers every
  output key as required-but-possibly-undefined, so `OrgMetadata` could not be satisfied by
  `{}` — which is exactly what the wire sends when an org has no metadata. The three shapes
  with optional fields (`OrgMetadata`, `OrgDirectoryEntry`, `OrgSearchResult`) declare an
  interface and annotate the transform's return against it. Worth knowing for Phase B:
  `ts-jest` runs with `diagnostics: false`, so **only `npm run tscheck` catches this class
  of bug** — a green test run does not mean the types are sound.

### Open
- **OQ-A2 — Sponsored gas.** The app signs everything through `useSignAndExecuteSponsored`,
  and treasury deposits rely on `coinWithBalance({ useGasCoin: false })` so a SUI-type
  deposit never splits a sponsor-owned gas coin. The executor pattern covers signing, but
  the SDK must set that flag itself. Ties into the post-MVP `sponsor` hook (DESIGN.md §9).
- **OQ-A3 — Metadata upload.** Org create and `metadata.update` need an uploaded URI. Take
  `metadataUri` as a required param (simple, honest), or accept a pluggable uploader the way
  keyspace accepts storage adapters (nicer, more surface). Leaning param-only for Phase B.
- **OQ-A4 — RESOLVED by cycle 7.** Each generic instantiation is its own slot, so enabling
  `PlaceLimitOrderCoin<B, Q>` binds nothing else; coin pairs are enabled per base
  (`orders.enableCoinPair`, `tradingTypeEntries(..., baseTypes)`). The original note:
  `enableTrading({ baseType })` was a permanent footgun. Passing `baseType` binds
  the coin-order type keys (`PlaceLimitOrderCoin` / `CancelOrderCoin`) to **one** base coin,
  immutably on-chain; the org can then trade only that base through governance. Orgs created
  by `create_tribe_configured` already have the unbound keys registered and should leave it
  undefined. Needs a parameter name and doc comment that make the irreversibility
  unmissable — or a separate `enableCoinPoolTradingForBase()` method so it can't be passed
  by accident.
- **OQ-A11 — RULED (1), cycle 7.** `runBatch` resolves every action and throws
  `ValidationFailed` naming the disagreement when strategies differ (a blocked action
  returns `blocked`). The original question:
  `runBatch`'s contract: does it route, or does it batch?

  Today it resolves the FIRST action and applies that strategy to all of them, without
  checking the rest agree. For its intended use — enable N trading types, every one an
  `EnableProposalType` on the same board — that is exactly right and cheap. For a mixed
  cart it is a silent mis-route: pair `members.add` (usually `control-execute`, on the
  PARENT board) with `metadata.update` (own-only) and the second is forced down a control
  path it has no adapter for. Today that throws `ValidationFailed` from `appendStrategy`,
  which is at least loud — but a cart where both actions HAVE both adapters would instead
  submit successfully to the wrong board, which is the case worth preventing.

  Three ways to settle it:

  1. **Validate and reject** — resolve every action, require identical strategies, else
     throw naming the disagreement. Costs one extra config read per distinct type (the
     handle already caches per DAO, so usually zero extra I/O). Keeps one signature, which
     is the whole point of the method.
  2. **Document the contract** — rename to `runBatchAs(strategy, actions)` and make the
     caller state the strategy. Honest, but pushes the resolver's job back onto the caller
     and makes the common case wordier.
  3. **Route per action** — resolve each independently and emit one transaction per
     strategy group. Most correct, but silently turns one signature into several, which a
     wallet-driven caller will notice and a bot may not.

  **Leaning (1).** It preserves the one-signature promise, the cost is near zero given the
  cache, and a mixed cart is far more likely to be a mistake than an intention. (3) is the
  right answer only if a real caller turns up wanting to fire a heterogeneous cart, and
  nothing in `triex-app-api` does — its only batch is `enableTradingActions`.

  Not blocking Phase C: nothing in the treasury or trading surface calls `runBatch` with a
  mixed cart.
- **OQ-A5 — Which composed sweeps are first-class?** `sweepAll` is clearly worth it. Whether
  `sweep()` should also accept a hand-built plan, or only ever compute its own, is a
  Phase-D call.
- **OQ-A6 — RESOLVED.** `units.pause` / `units.unpause` (`PauseSubOUExecution` /
  `UnpauseSubOUExecution`, control adapters). The original note: `PauseSubDAOExecution`
  had no builder. `create_tribe_configured` enables and
  labels the type, and `ProposalConfigSettings` will render it, but nothing can submit one.
  Either wire it (small — `subdao/pause_execution.move` exists) or stop enabling it at
  creation. Worth raising against the app regardless of what this module does.

---

## 12. Indexer lag & consistency

DESIGN.md §12 applies unchanged: writes are validated on-chain, so a stale read can only
produce a transaction that aborts and rolls back. Two org-specific edges:

**Edge 1 — membership and proposal reads lag chain finality by seconds.** The app patches
its query cache optimistically after a board change (`patchBoardMembers` in
`src/utils/orgNodes.ts`) and lets a delayed refetch reconcile. The SDK equivalent is
narrower and cheaper: after a successful `members.*` or `metadata.*` run, **invalidate the
handle's cached tree and governance** rather than trying to patch them. A bot that needs
confirmation should use `untilIndexed` (already in the SDK) against
`GET /v1/orgs/{org_id}`.

**Edge 2 — a freshly created proposal is not in `/v1/orgs/{id}/proposals` yet.** Never poll
for it — and `vote` / `execute` / `deleteExpired` read the LIVE object first (payload type
and owning OU), so they work before the indexer catches up. Cycle 7's single-PTB
executions create no `Proposal` at all (`RunOutcome.proposalId` is then undefined, by
design). `submit_proposal` still creates a `Proposal<P>` object, so the id comes out of the
transaction's created objects — that is what `extractCreatedProposalId` does in the app and
what populates `RunOutcome.proposalId`. Same rule as the trading module's balance-manager
id: trust returned object ids over an immediate re-read.

**Not affected by lag:** the DAO governance read (§8) is a fullnode read and is always
head-current — which matters, because the resolver's answer is only as correct as the
config it read.

---

## 13. Appendices

### 13.1 Gateway route inventory (org family)

All enabled today; CU costs from the published swagger. Contrast with DESIGN.md §13, where
Phase 0 had to enable the market family first.

```
GET /v1/orgs                                       (50 CU)   # A3  batch, ≤200
GET /v1/orgs/directory                             (50 CU)   # A4  cursor-paged
GET /v1/orgs/{org_id}                              (30 CU)   # A2  full unit tree
GET /v1/orgs/{org_id}/proposals                    (30 CU)   # A7  discovery only
GET /v1/players/{address}/orgs                     (30 CU)   # A1
GET /v1/players/{address}/accessible-keyspaces     (30 CU)   # A10
GET /v1/hubs/{hub_id}/dao-vaults                   (30 CU)   # E1  vault + netted ACL
GET /v1/balance-managers/owners                    (50 CU)   # A6  already wrapped (ou: tag)
GET /v1/search                                     (100 CU)  # A5  characters + orgs
GET /v1/stats                                      (50 CU)   # adjacent: StatsOrganizations
GET /v1/world/tribes/{tribe_id}                    (20 CU)   # adjacent: game-world factions
```

Caching, per the swagger: orgs and keyspaces 5 min, DAO vaults 30 s.

### 13.2 Coverage — every cycle-7 proposal type and entry point

"Control" means the parent applies it to a child via its `SubOUControl` (the resolver is
handed the CHILD's context). Bits are what the handler checks; framework types hold
theirs on-chain by construction.

**armature_framework proposal types** (handlers in `armature::*_ops`)

| Type (display key) | SDK | Path | Bits |
|---|---|---|---|
| `SetBoard` | `members.setBoard({add, remove})` / `setBoardAction` | own | BOARD_SET (fixed) |
| `AddMember` / `RemoveMember` | `addMemberAction` / `removeMemberAction`; executed via `governance.execute` | own | fixed |
| `BatchAddMembers` / `BatchRemoveMembers` | `members.add` / `members.remove` | own (+ control below) | fixed |
| `UpdateMetadata` (`CharterUpdate`) | `metadata.update` | own | METADATA (fixed) |
| `EnableProposalType` | `types.enable` / `enableTrading` / `enableSendCoin*` / `enableSendSmallPayment` / `currency.enable` | own | TYPE_ADMIN (fixed); whole-board 80% |
| `DisableProposalType` | `types.disable` | own | TYPE_ADMIN |
| `UpdateProposalConfig` | `types.updateConfig` (incl. `permissions`, `borrowScope`) | own | TYPE_ADMIN; whole-board 80% |
| `EnableBypassType` / `DisableBypassType` | `capabilities.enableBypass` / `disableBypass` | own (root only) | fixed |
| `TransferFreezeAdmin` / `UnfreezeProposalType` | `freeze.transferAdmin` / `freeze.unfreeze` | own | FREEZE |
| `UpdateFreezeConfig` / `UpdateFreezeExemptTypes` | `freeze.setMaxDuration` / `freeze.updateExempt` | own | FREEZE |
| `CreateSubOU` / `SpawnOU` | `units.create` / `units.spawnSuccessor` | own | fixed, 80% |
| `SpinOutSubOU` | `units.spinOut({unitId})` | control (parent's own type) | fixed, 80% |
| `TransferAssets` | `units.transferAssets` (hot-potato execution) | own; runs while migrating | fixed, 80% |
| `CompositePayload` (`Composite`) | `governance.runComposite` / `execute` | own | none |

**armature_proposals types**

| Type | SDK | Path | Bits / scope |
|---|---|---|---|
| `SendCoin<T>` / `SendCoinToOU<T>` | `treasury.send` / `treasury.sendToOrg` | own | TREASURY_WITHDRAW |
| `SendSmallPayment<T>` | `treasury.sendSmall` | own | TREASURY_WITHDRAW |
| `AdoptCurrency<T>` | `currency.adopt` | own | VAULT_STORE |
| `MintCoin<T>` / `MintAllowance<T>` | `currency.mint` / `currency.mintAllowance` | own | VAULT_BORROW · `TreasuryCap<T>` |
| `BurnCoin<T>` | `currency.burn` | own | TREASURY_WITHDRAW + VAULT_BORROW · `TreasuryCap<T>` |
| `ReturnCurrencyCap<T>` | `currency.returnCap` | own | VAULT_EXTRACT |
| `ConfigureMintAllowance<T>` | `currency.configureAllowance` | own | none |
| `ControllerBatchAddMembers` / `…RemoveMembers` | `members.add` / `members.remove` | control | VAULT_BORROW · `SubOUControl` |
| `PauseSubOUExecution` / `UnpauseSubOUExecution` | `units.pause` / `units.unpause` | control | VAULT_BORROW · `SubOUControl` |
| `TransferCapToSubOU` | `units.transferCap` | control | VAULT_EXTRACT |
| `ReclaimCapFromSubOU` | `units.reclaimCap` | control | VAULT_BORROW + VAULT_STORE · `SubOUControl` |
| `ProposeUpgrade` | `upgrade.propose` / `execute(id, {upgrade})` | own | VAULT_BORROW · `UpgradeCap` |
| `tribe_setup::create_tribe[_configured]` | `orgs.create` | direct | — |
| `type_permissions::*` | mirrored as `PERMISSIONS` / `currencyTypeEntries` / `tradingTypeEntries` | pure | — |

**Direct entry points (no vote)** — `board_voting::{vote, submit_*, ticket_from_vote*}`,
`proposal::delete_expired_proposal`, `composite::*` incl. `delete_exhausted_frame`,
`treasury_vault::{deposit, claim_coin}`, `emergency::{freeze_type, unfreeze_type}`,
`encrypted_entry::{publish, update, edit, rotate_encryption_epoch, remove}_entry`,
`ou::{create, destroy}`, `currency_ops::mint_allowance_bypass`.

Config presets ship as named exports: `TRADING_TYPE_CONFIG` (quorum 1, 1h),
`GOVERNANCE_TYPE_CONFIG` (50/50, 7d, no bits), `TREASURY_TYPE_CONFIG` (50/80 +
TREASURY_WITHDRAW — the 80% floor that bit requires), `WHOLE_BOARD_TYPE_CONFIG` (80/100 —
the framework default for the type-admin meta-types), `COMPOSITE_TYPE_CONFIG` (50/80),
`HIERARCHY_TYPE_CONFIG` (80/80).

### 13.3 Exclusions — what cannot be exposed safely (cycle 7)

| Entry point | Why |
|---|---|
| `controller::{privileged_submit, privileged_consume, privileged_extract, receive_cap_from_controller, assert_registered_control}` | Need a `&SubOUControl`, which only exists inside a handler that loaned it from the parent's vault — reached through the `subou_ops` / `lifecycle_ops` control actions |
| `external_execution::ticket_from_cap[_readonly]` | Need `Permit<P>`, mintable only by `P`'s own module; the first-party bypass is wrapped as `currency.mintWithAllowance` |
| `tribe::create_wired_subou` | Needs an `ExecutionRequest` (`ticket_request` needs `Permit<P>`) — handler-only |
| `tribe::create_tribe[_configured]` (framework) | Superseded by `tribe_setup` (same tree, controls usable); the framework form leaves them dormant |
| `ou::{create_subou, create_subou_configured, share_subou}` | Produce an orphan sub-OU whose controller id nothing can hold (the `SubOUControl` constructor is package-internal); `units.create` is the safe path |
| `ou::set_execution_paused` (PAUSE bit) | No first-party payload type holds PAUSE; a third-party type's handler would call it |
| `capability_vault::*` request-taking mutators, `borrow_external_cap` | Handler plumbing (request-gated) / a borrow with no effect outside a bypass mint |
| `admin_ops::propose_update_proposal_config` | A submission wrapper whose extra check the OU already enforces on every stored config; `submit_proposal<UpdateProposalConfig>` is equivalent |
| `encrypted_entry::seal_approve` | `entry` fun for the Seal key server's dry-run, not a transaction to send (decryption lives in `@trinaryex/keyspace`) |
| `spend_guard::*`, `utils::*`, `permissions::*`, accessors | Pure library values / reads with no transaction of their own (bits mirrored as `PERMISSIONS`) |
| `armature_world_bridge` (`AutojoinOU`) | Not configured in the SDK (the app dropped it); world-bridge self-join is a game-client flow |
| `armature_trading::*` | Owned by the trading module (`trading.ts`, `org.orders`) |

`encrypted_entry` is member-gated by design — any current board member may publish,
edit, re-key or remove with no permission bit — and the SDK exposes it as such
(`org.entries`, plain `TxResult`).
