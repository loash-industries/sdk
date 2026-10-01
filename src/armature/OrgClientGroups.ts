import { TriexClientError, TriexError } from '../errors'
import type { TxResult } from '../types'
import {
  disableBypassTypeAction,
  enableBypassTypeAction,
  enableProposalTypeAction,
  GOVERNANCE_TYPE_CONFIG,
} from './actions'
import {
  adoptCurrencyAction,
  burnCoinAction,
  configureMintAllowanceAction,
  currencyTypeEntries,
  mintAllowanceAction,
  mintAllowanceBypassTx,
  mintCoinAction,
  returnCurrencyCapAction,
} from './currency'
import {
  fetchFreezeState,
  fetchOuState,
  type FreezeState,
  normalizeMoveType,
} from './governance'
import {
  createSubOuAction,
  pauseSubOuAction,
  reclaimCapFromSubOuAction,
  spawnOuAction,
  type SpinOutConfigs,
  spinOutSubOuAction,
  transferAssetsAction,
  transferCapToSubOuAction,
  transferFreezeAdminAction,
  unfreezeProposalTypeAction,
  unpauseSubOuAction,
  updateFreezeConfigAction,
  updateFreezeExemptTypesAction,
} from './lifecycle'
import type { OrgHandle, RunOptions, RunOutcome } from './OrgClient'
import {
  capTypeOf,
  type CapabilityVaultContents,
  type EncryptedEntry,
  fetchEncryptedEntries,
} from './proposals'
import {
  destroyOuTx,
  editEntryTx,
  freezeTypeTx,
  publishEntryTx,
  removeEntryTx,
  rotateEncryptionEpochTx,
  type ProposalConfigInput,
  unfreezeTypeTx,
  updateEntryTx,
} from './transactions'
import { proposeUpgradeAction, type UpgradeBuild } from './upgrade'

/**
 * The cycle-7 handle groups: currency, sub-unit lifecycle & control, the
 * emergency freeze, encrypted entries, upgrades, and capability reads.
 *
 * Kept beside `OrgClient.ts` rather than in it so each group stays readable;
 * they are reached only through `client.org(id).<group>`. Governance writes
 * return `RunOutcome` (resolver-routed); cap-holder and member-gated calls that
 * need no vote return a plain `TxResult` — the return type IS the
 * authorization model, as with `treasury.deposit`.
 */

/** @internal — a required id or a typed error naming it. */
function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined || v === '') {
    throw new TriexClientError(TriexError.ValidationFailed, `Missing ${what}.`)
  }
  return v
}

// ─── currency ────────────────────────────────────────────────────────────────

export class OrgCurrencyApi {
  constructor(private readonly h: OrgHandle) {}

  /** @internal — the unit's vault + treasury. */
  private ids(unitId?: string) {
    const node = this.h.requireNode(unitId)
    return {
      capabilityVaultId: need(
        node.capabilityVaultId,
        `CapabilityVault of ${node.daoId}`,
      ),
      treasuryVaultId: need(node.treasuryId, `TreasuryVault of ${node.daoId}`),
    }
  }

  /**
   * Enable the currency types for one coin — `AdoptCurrency`, `MintCoin`,
   * `BurnCoin`, `ReturnCurrencyCap`, `ConfigureMintAllowance` — each with the
   * bits / `TreasuryCap<T>` scope its handler needs, in one transaction.
   * `config` is the base (default: 50% quorum); bit-holding types are lifted
   * to 80% approval automatically.
   */
  async enable(
    params: { coinType: string; config?: ProposalConfigInput },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const gov = await this.h.gov(this.h.contextFor(opts?.unitId).daoId)
    const have = new Set((gov.slots ?? []).map((s) => s.typeName))
    const actions = currencyTypeEntries(
      this.h.deps.ids.armatureProposals,
      params.coinType,
      params.config ?? GOVERNANCE_TYPE_CONFIG,
    )
      .filter((e) => !have.has(normalizeMoveType(e.moveType)))
      .map((e) =>
        enableProposalTypeAction(this.h.pkgs(), {
          kind: 'enable_currency',
          enabledTypeKey: e.typeKey,
          enabledMoveType: e.moveType,
          config: e.config,
        }),
      )
    if (actions.length === 0) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Every currency type for ${params.coinType} is already enabled.`,
      )
    }
    return this.h.governance.runBatch(actions, opts)
  }

  /** Hand the coin's `TreasuryCap<T>` (owned by the caller) to the organization. */
  adopt(
    params: { coinType: string; treasuryCapId: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      adoptCurrencyAction(this.h.pkgs(), {
        ...params,
        capabilityVaultId: this.ids(opts?.unitId).capabilityVaultId,
      }),
      opts,
    )
  }

  /** Mint into the treasury (or to `recipient`) by vote (`MintCoin<T>`). */
  mint(
    params: {
      coinType: string
      treasuryCapId: string
      amount: bigint
      recipient?: string
    },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      mintCoinAction(this.h.pkgs(), { ...params, ...this.ids(opts?.unitId) }),
      opts,
    )
  }

  /** `MintAllowance<T>` by vote — same mechanics as `mint`. */
  mintAllowance(
    params: {
      coinType: string
      treasuryCapId: string
      amount: bigint
      recipient?: string
    },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      mintAllowanceAction(this.h.pkgs(), {
        ...params,
        ...this.ids(opts?.unitId),
      }),
      opts,
    )
  }

  /** Configure who may mint through the `MintAllowance<T>` bypass (by vote). */
  configureAllowance(
    params: {
      coinType: string
      addMinters?: string[]
      removeMinters?: string[]
      maxPerCall?: bigint
      enabled?: boolean
    },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      configureMintAllowanceAction(this.h.pkgs(), params),
      opts,
    )
  }

  /**
   * Mint WITHOUT a vote through the `MintAllowance<T>` bypass. Not governance:
   * the CALLER must be an allowlisted minter and `amount ≤ max_per_call`.
   * `bypassCapId` defaults to the vault's `ExternalExecutionCap<MintAllowance<T>>`.
   */
  async mintWithAllowance(params: {
    coinType: string
    treasuryCapId: string
    amount: bigint
    recipient?: string
    bypassCapId?: string
    unitId?: string
  }): Promise<TxResult> {
    const node = this.h.requireNode(params.unitId)
    const ids = this.ids(params.unitId)
    let bypassCapId = params.bypassCapId
    if (!bypassCapId) {
      const vault = await this.h.capabilityVault(ids.capabilityVaultId)
      const capType = normalizeMoveType(
        `${this.h.deps.ids.armature}::proposal::ExternalExecutionCap<${this.h.deps.ids.armatureProposals}::mint_allowance::MintAllowance<${params.coinType}>>`,
      )
      bypassCapId = vault.byType.get(capType)?.[0]
    }
    return this.h.submit(
      mintAllowanceBypassTx({
        armatureProposals: this.h.deps.ids.armatureProposals,
        coinType: params.coinType,
        ouId: node.daoId,
        capabilityVaultId: ids.capabilityVaultId,
        treasuryVaultId: ids.treasuryVaultId,
        emergencyFreezeId: need(node.emergencyFreezeId, 'EmergencyFreeze'),
        bypassCapId: need(
          bypassCapId,
          'a MintAllowance bypass cap — enable it with types.enableBypass first',
        ),
        treasuryCapId: params.treasuryCapId,
        amount: params.amount,
        recipient: params.recipient,
      }),
    )
  }

  /** Withdraw from the treasury and burn (`BurnCoin<T>`). */
  burn(
    params: { coinType: string; treasuryCapId: string; amount: bigint },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      burnCoinAction(this.h.pkgs(), { ...params, ...this.ids(opts?.unitId) }),
      opts,
    )
  }

  /** Give the `TreasuryCap<T>` back to an address (`ReturnCurrencyCap<T>`). */
  returnCap(
    params: { coinType: string; treasuryCapId: string; recipient: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      returnCurrencyCapAction(this.h.pkgs(), {
        ...params,
        capabilityVaultId: this.ids(opts?.unitId).capabilityVaultId,
      }),
      opts,
    )
  }
}

// ─── sub-units: lifecycle & control ──────────────────────────────────────────

export class OrgUnitsApi {
  constructor(private readonly h: OrgHandle) {}

  /** @internal — a CHILD unit (not the root) and its vault. */
  private child(unitId: string) {
    const node = this.h.requireNode(unitId)
    if (!node.parentDaoId) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        `Unit ${unitId} is the root — it has no parent to act through.`,
      )
    }
    return {
      node,
      vaultId: need(node.capabilityVaultId, `CapabilityVault of ${unitId}`),
    }
  }

  /** @internal — a cap's Move type, read from `vaultId` when not given. */
  private async capType(
    vaultId: string,
    capId: string,
    given?: string,
  ): Promise<string> {
    if (given) return given
    const t = capTypeOf(await this.h.capabilityVault(vaultId), capId)
    return need(t, `the Move type of cap ${capId} (not in vault ${vaultId})`)
  }

  /**
   * Create a child unit under the acting unit (`CreateSubOU`). The type is not
   * a default slot (enable it at ≥80% approval) and is blocked on controlled
   * sub-units.
   */
  create(
    params: { name: string; board: string[]; metadataUri: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const node = this.h.requireNode(opts?.unitId)
    return this.h.governance.run(
      createSubOuAction(this.h.pkgs(), {
        ...params,
        capabilityVaultId: need(node.capabilityVaultId, 'CapabilityVault'),
      }),
      opts,
    )
  }

  /** Pause a child unit's own executions (parent's board decides). */
  pause(params: { unitId: string }, opts?: RunOptions): Promise<RunOutcome> {
    this.child(params.unitId)
    return this.h.governance.run(pauseSubOuAction(this.h.pkgs()), {
      ...opts,
      unitId: params.unitId,
    })
  }

  /** Resume a paused child unit. */
  unpause(params: { unitId: string }, opts?: RunOptions): Promise<RunOutcome> {
    this.child(params.unitId)
    return this.h.governance.run(unpauseSubOuAction(this.h.pkgs()), {
      ...opts,
      unitId: params.unitId,
    })
  }

  /** Move a capability from the parent's vault into a child's. */
  async transferCap(
    params: { unitId: string; capId: string; capType?: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const { node, vaultId } = this.child(params.unitId)
    const parent = this.h.requireNode(node.parentDaoId!)
    const capType = await this.capType(
      need(parent.capabilityVaultId, 'parent CapabilityVault'),
      params.capId,
      params.capType,
    )
    return this.h.governance.run(
      transferCapToSubOuAction(this.h.pkgs(), {
        subOuId: node.daoId,
        subOuCapabilityVaultId: vaultId,
        capId: params.capId,
        capType,
      }),
      { ...opts, unitId: params.unitId },
    )
  }

  /** Pull a capability out of a child's vault back into the parent's. */
  async reclaimCap(
    params: { unitId: string; capId: string; capType?: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const { node, vaultId } = this.child(params.unitId)
    const capType = await this.capType(vaultId, params.capId, params.capType)
    return this.h.governance.run(
      reclaimCapFromSubOuAction(this.h.pkgs(), {
        subOuId: node.daoId,
        subOuCapabilityVaultId: vaultId,
        capId: params.capId,
        capType,
      }),
      { ...opts, unitId: params.unitId },
    )
  }

  /**
   * Release a child from its parent (`SpinOutSubOU`) — IRREVERSIBLE. The
   * parent's vault must hold the child's `FreezeAdminCap` (true for units made
   * by `units.create`, not for tribe units); it is looked up when omitted.
   */
  async spinOut(
    params: {
      unitId: string
      freezeAdminCapId?: string
      configs?: Partial<SpinOutConfigs>
    },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const { node, vaultId } = this.child(params.unitId)
    const parent = this.h.requireNode(node.parentDaoId!)
    let freezeAdminCapId = params.freezeAdminCapId
    if (!freezeAdminCapId && parent.capabilityVaultId) {
      const v = await this.h.capabilityVault(parent.capabilityVaultId)
      const capType = normalizeMoveType(
        `${this.h.deps.ids.armature}::emergency::FreezeAdminCap`,
      )
      // The vault does not record which unit a FreezeAdminCap belongs to;
      // take it only when exactly one is held.
      const caps = v.byType.get(capType) ?? []
      if (caps.length === 1) freezeAdminCapId = caps[0]
    }
    return this.h.governance.run(
      spinOutSubOuAction(this.h.pkgs(), {
        subOuId: node.daoId,
        subOuCapabilityVaultId: vaultId,
        freezeAdminCapId: need(
          freezeAdminCapId,
          "the child's FreezeAdminCap id in the parent's vault — pass `freezeAdminCapId`",
        ),
        configs: params.configs,
      }),
      { ...opts, unitId: params.unitId },
    )
  }

  /**
   * Spawn a successor OU and put the acting unit into `Migrating`
   * (`SpawnOU`) — IRREVERSIBLE; afterwards only `transferAssets` runs.
   */
  spawnSuccessor(
    params: { board: string[]; name: string; metadataUri: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(spawnOuAction(this.h.pkgs(), params), opts)
  }

  /**
   * Move coins (full balances) and capabilities to another OU
   * (`TransferAssets`). Defaults to EVERYTHING the unit holds; the target's
   * treasury and vault are read from its OU object.
   */
  async transferAssets(
    params: { targetOuId: string; coinTypes?: string[]; capIds?: string[] },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const node = this.h.requireNode(opts?.unitId)
    const treasuryVaultId = need(node.treasuryId, 'TreasuryVault')
    const capabilityVaultId = need(node.capabilityVaultId, 'CapabilityVault')
    const target = await fetchOuState(this.h.deps.suiClient, params.targetOuId)
    const vault = await this.h.capabilityVault(capabilityVaultId)
    let coinTypes = params.coinTypes
    if (!coinTypes) {
      const balances = await this.h.treasury.balances(treasuryVaultId)
      coinTypes = balances.map((b) => normalizeMoveType(b.coinType))
    }
    const capIds = params.capIds ?? vault.capIds
    const caps = capIds.map((id) => ({
      id,
      type: need(capTypeOf(vault, id), `the Move type of cap ${id}`),
    }))
    return this.h.governance.run(
      transferAssetsAction(this.h.pkgs(), {
        targetOuId: params.targetOuId,
        targetTreasuryId: target.treasuryId,
        targetCapabilityVaultId: target.capabilityVaultId,
        coinTypes,
        caps,
        treasuryVaultId,
        capabilityVaultId,
      }),
      opts,
    )
  }

  /**
   * Permissionless cleanup of a MIGRATING unit (`ou::destroy`): deletes it and
   * its four companion objects once its treasury and vault are empty.
   */
  async destroy(params: { unitId: string }): Promise<TxResult> {
    const node = this.h.requireNode(params.unitId)
    return this.h.submit(
      destroyOuTx({
        armature: this.h.deps.ids.armature,
        ouId: node.daoId,
        treasuryId: need(node.treasuryId, 'TreasuryVault'),
        capabilityVaultId: need(node.capabilityVaultId, 'CapabilityVault'),
        charterId: need(node.charterId, 'Charter'),
        emergencyFreezeId: need(node.emergencyFreezeId, 'EmergencyFreeze'),
      }),
    )
  }
}

// ─── emergency freeze ────────────────────────────────────────────────────────

export class OrgFreezeApi {
  constructor(private readonly h: OrgHandle) {}

  private freezeId(unitId?: string): string {
    const node = this.h.requireNode(unitId)
    return need(node.emergencyFreezeId, `EmergencyFreeze of ${node.daoId}`)
  }

  /** Which Move types are frozen on a unit (and until when), and which are exempt. */
  async read(unitId?: string): Promise<FreezeState> {
    return fetchFreezeState(this.h.deps.suiClient, this.freezeId(unitId))
  }

  /**
   * Freeze one payload Move type on a unit (`emergency::freeze_type`). The
   * CALLER must own the unit's `FreezeAdminCap`; no vote.
   */
  async freezeType(params: {
    moveType: string
    freezeAdminCapId: string
    unitId?: string
  }): Promise<TxResult> {
    return this.h.submit(
      freezeTypeTx({
        armature: this.h.deps.ids.armature,
        emergencyFreezeId: this.freezeId(params.unitId),
        freezeAdminCapId: params.freezeAdminCapId,
        moveType: params.moveType,
      }),
    )
  }

  /** Lift a freeze early with the `FreezeAdminCap` (`emergency::unfreeze_type`). */
  async unfreezeType(params: {
    moveType: string
    freezeAdminCapId: string
    unitId?: string
  }): Promise<TxResult> {
    return this.h.submit(
      unfreezeTypeTx({
        armature: this.h.deps.ids.armature,
        emergencyFreezeId: this.freezeId(params.unitId),
        freezeAdminCapId: params.freezeAdminCapId,
        moveType: params.moveType,
      }),
    )
  }

  /** Lift a freeze by board vote (`UnfreezeProposalType`), no cap needed. */
  unfreeze(
    params: { moveType: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      unfreezeProposalTypeAction(this.h.pkgs(), {
        moveType: params.moveType,
        emergencyFreezeId: this.freezeId(opts?.unitId),
      }),
      opts,
    )
  }

  /** Change the freeze duration by vote (`UpdateFreezeConfig`; enable it first). */
  setMaxDuration(
    params: { maxFreezeDurationMs: number },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      updateFreezeConfigAction(this.h.pkgs(), {
        maxFreezeDurationMs: params.maxFreezeDurationMs,
        emergencyFreezeId: this.freezeId(opts?.unitId),
      }),
      opts,
    )
  }

  /** Edit the freeze-exempt set by vote (`UpdateFreezeExemptTypes`; enable it first). */
  updateExempt(
    params: { add?: string[]; remove?: string[] },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      updateFreezeExemptTypesAction(this.h.pkgs(), {
        ...params,
        emergencyFreezeId: this.freezeId(opts?.unitId),
      }),
      opts,
    )
  }

  /**
   * Hand the `FreezeAdminCap` to a new admin by vote (`TransferFreezeAdmin`),
   * unfreezing everything. The EXECUTOR must own the cap — on a slow path,
   * execute later with `governance.execute(id, { freezeAdminCapId })`.
   */
  transferAdmin(
    params: { newAdmin: string; freezeAdminCapId: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    return this.h.governance.run(
      transferFreezeAdminAction(this.h.pkgs(), {
        ...params,
        emergencyFreezeId: this.freezeId(opts?.unitId),
      }),
      opts,
    )
  }
}

// ─── encrypted entries ───────────────────────────────────────────────────────

/**
 * Seal-encrypted entries a unit's board shares. MEMBER-GATED by design: any
 * current board member may publish, edit, re-key or remove, with no vote and
 * no permission bit. Encryption itself lives in `@trinaryex/keyspace`.
 */
export class OrgEntriesApi {
  constructor(private readonly h: OrgHandle) {}

  private unit(unitId?: string): string {
    return this.h.requireNode(unitId).daoId
  }

  /** Every entry of a unit, with a `stale` flag for those under an old epoch. */
  async list(unitId?: string): Promise<EncryptedEntry[]> {
    const gov = await this.h.gov(this.unit(unitId))
    const state = need(gov.state, 'the unit state')
    return fetchEncryptedEntries(
      this.h.deps.suiClient,
      state.entries,
      state.encryptEpoch,
    )
  }

  /** Index a new encrypted blob (max 32 per unit). Upload the ciphertext first. */
  async publish(params: {
    location: string
    description: string
    unitId?: string
  }): Promise<TxResult> {
    return this.h.submit(
      publishEntryTx({
        armature: this.h.deps.ids.armature,
        ouId: this.unit(params.unitId),
        location: params.location,
        description: params.description,
      }),
    )
  }

  /** Re-point a STALE entry at its re-encrypted blob (stamps the current epoch). */
  async update(params: {
    entryId: string
    location: string
    unitId?: string
  }): Promise<TxResult> {
    return this.h.submit(
      updateEntryTx({
        armature: this.h.deps.ids.armature,
        ouId: this.unit(params.unitId),
        entryId: params.entryId,
        location: params.location,
      }),
    )
  }

  /** Move a blob within the same epoch (no re-key). */
  async edit(params: {
    entryId: string
    location: string
    unitId?: string
  }): Promise<TxResult> {
    return this.h.submit(
      editEntryTx({
        armature: this.h.deps.ids.armature,
        ouId: this.unit(params.unitId),
        entryId: params.entryId,
        location: params.location,
      }),
    )
  }

  /** Rotate the unit's encryption epoch, marking every entry stale. */
  async rotateEpoch(params?: { unitId?: string }): Promise<TxResult> {
    return this.h.submit(
      rotateEncryptionEpochTx({
        armature: this.h.deps.ids.armature,
        ouId: this.unit(params?.unitId),
      }),
    )
  }

  /** Unindex and delete an entry. */
  async remove(params: {
    entryId: string
    unitId?: string
  }): Promise<TxResult> {
    return this.h.submit(
      removeEntryTx({
        armature: this.h.deps.ids.armature,
        ouId: this.unit(params.unitId),
        entryId: params.entryId,
      }),
    )
  }
}

// ─── upgrades ────────────────────────────────────────────────────────────────

export class OrgUpgradeApi {
  constructor(private readonly h: OrgHandle) {}

  /**
   * Propose (and on a single-vote path, perform) an upgrade of a package whose
   * `UpgradeCap` the unit custodies. `build` is needed only to execute; a
   * passed proposal executes via `governance.execute(id, { upgrade })`.
   */
  propose(
    params: {
      capId: string
      packageId: string
      digest: number[] | Uint8Array
      policy?: number
      build?: UpgradeBuild
    },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const node = this.h.requireNode(opts?.unitId)
    return this.h.governance.run(
      proposeUpgradeAction(this.h.pkgs(), {
        ...params,
        capabilityVaultId: need(node.capabilityVaultId, 'CapabilityVault'),
      }),
      opts,
    )
  }
}

// ─── capabilities & bypass ───────────────────────────────────────────────────

export class OrgCapabilitiesApi {
  constructor(private readonly h: OrgHandle) {}

  /**
   * What a unit's capability vault holds, by Move type — `SubOUControl`s,
   * `TreasuryCap`s, `ExternalExecutionCap`s, `UpgradeCap`s, a stored
   * `FreezeAdminCap`, trading custody caps.
   */
  async list(unitId?: string): Promise<CapabilityVaultContents> {
    const node = this.h.requireNode(unitId)
    return this.h.capabilityVault(
      need(node.capabilityVaultId, `CapabilityVault of ${node.daoId}`),
    )
  }

  /**
   * Opt a unit into BYPASS execution for one type (`EnableBypassType`): the
   * type's own package may then mint tickets without a vote. 80% of the WHOLE
   * board must vote YES; never on a controlled sub-unit.
   */
  enableBypass(
    params: { typeKey: string; moveType: string; config: ProposalConfigInput },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const node = this.h.requireNode(opts?.unitId)
    return this.h.governance.run(
      enableBypassTypeAction(this.h.pkgs(), {
        ...params,
        capabilityVaultId: need(node.capabilityVaultId, 'CapabilityVault'),
      }),
      opts,
    )
  }

  /**
   * Opt out of bypass execution (`DisableBypassType`). `capId` defaults to the
   * vault's `ExternalExecutionCap<moveType>`; `typeKey` to the slot's label.
   */
  async disableBypass(
    params: { moveType: string; typeKey?: string; capId?: string },
    opts?: RunOptions,
  ): Promise<RunOutcome> {
    const node = this.h.requireNode(opts?.unitId)
    const vaultId = need(node.capabilityVaultId, 'CapabilityVault')
    let capId = params.capId
    if (!capId) {
      const v = await this.h.capabilityVault(vaultId)
      capId = v.byType.get(
        normalizeMoveType(
          `${this.h.deps.ids.armature}::proposal::ExternalExecutionCap<${params.moveType}>`,
        ),
      )?.[0]
    }
    let typeKey = params.typeKey
    if (!typeKey) {
      const gov = await this.h.gov(node.daoId)
      typeKey = gov.slots?.find(
        (s) => s.typeName === normalizeMoveType(params.moveType),
      )?.displayKey
    }
    return this.h.governance.run(
      disableBypassTypeAction(this.h.pkgs(), {
        typeKey: need(typeKey, `an enabled slot for ${params.moveType}`),
        moveType: params.moveType,
        capId: need(capId, `an ExternalExecutionCap for ${params.moveType}`),
        capabilityVaultId: vaultId,
      }),
      opts,
    )
  }
}
