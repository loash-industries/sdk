import type { ClientWithCoreApi } from '@mysten/sui/client'
import { normalizeStructTag } from '@mysten/sui/utils'
import { Transaction } from '@mysten/sui/transactions'
import { prepareCoinInput } from '../coins/funding'
import { TriexClientError, TriexError } from '../errors'
import { executeAndNormalize, findCreatedObject } from '../execute'
import { HangarCapBorrows, sourceItemBalance } from '../funding'
import { toSsuObjectId } from '../onchain'
import type { IndexerClient } from '../queries'
import type { PackageIds, TransactionExecutor, TxResult } from '../types'
import { HaulingApi } from './HaulingApi'
import type { HaulingQueries } from './queries'
import {
  acceptAgreement,
  cancelAgreement,
  collectProceeds,
  deleteListerCap,
  deliverAgreement,
  endAgreement,
  haulingIds,
  type HaulingPrincipal,
  payAll,
  postAgreement,
} from './transactions'
import type { HaulingAgreementDetail } from './types'

/** `F` for `draft` when the config charges no posting fee: an empty SUI coin. */
const NO_FEE_COIN = '0x2::sui::SUI'

/** What `TriexClient` hands the hauling writes. */
export interface HaulingWriteDeps {
  queries: HaulingQueries
  indexer: IndexerClient
  suiClient: ClientWithCoreApi
  ids: PackageIds
  requireAddress: (address?: string) => string
  requireExecutor: () => TransactionExecutor
}

/** One item, at a hub. */
export interface HaulingItem {
  assetId: string | bigint
  quantity: bigint
}

export interface PostAgreementParams {
  /** The hub the cargo is at (its storage unit id). */
  pickupStorageUnitId: string
  /**
   * What to escrow, from the pickup hub: wallet-held receipts in its
   * collection first, then the hangar there (see `useHangar`).
   */
  cargo: HaulingItem[]
  /** The hub the wanted items must reach. */
  destinationStorageUnitId: string
  /** What must be handed in at the destination. Default: the cargo. */
  want?: HaulingItem[]
  /** Reward and collateral coin type; default CRED. Must be approved in the config. */
  currency?: string
  /** Escrowed reward, raw base units of `currency`. */
  reward: bigint
  /** Collateral the hauler locks on accept, raw base units. */
  collateral: bigint
  /** How long the agreement can be accepted, ms from posting. */
  acceptWindowMs: number | bigint
  /** How long a hauler has to deliver once they accept, ms. */
  haulDurationMs: number | bigint
  /** Paid on delivery or default; omitted pays whoever holds the lister cap. */
  beneficiary?: string
  /** Who may accept (a claim gate); omitted: anyone. */
  principals?: HaulingPrincipal[]
  /** Draw cargo the wallet receipts can't cover from the pickup hangar. Default true. */
  useHangar?: boolean
}

/** A posted agreement: its object id and the lister cap kept by the sender. */
export interface PostedAgreement extends TxResult {
  agreementId: string | null
  capId: string | null
}

/**
 * Hauling agreements, reads and writes (`TriexClient.hauling`). Every write
 * builds one PTB, signed by the configured executor; item balances and coins
 * come from the configured player's wallet (and hangar), and anything the
 * contract hands back goes to them.
 */
export class HaulingWriteApi extends HaulingApi {
  constructor(private readonly d: HaulingWriteDeps) {
    super(d.queries, d.requireAddress)
  }

  /**
   * Post an agreement: escrow the cargo (from the pickup hub) and the
   * reward, pay the config's posting fee, optionally gate who may accept,
   * and keep the lister cap — it cancels the agreement and collects its
   * proceeds.
   * @throws `ValidationFailed`; `AddressRequired` | `ExecutorRequired`;
   *   `HubNotFound`; `InsufficientBalance`; `TransactionFailed`.
   */
  async post(params: PostAgreementParams): Promise<PostedAgreement> {
    const owner = this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    if (params.reward <= 0n || params.collateral <= 0n) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Reward and collateral must both be positive.',
      )
    }
    if (!params.cargo.length) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'Name at least one cargo item.',
      )
    }
    const currency = params.currency ?? this.d.ids.credCoinType
    const [pickup, destination, config] = await Promise.all([
      this.d.indexer.hubVault(params.pickupStorageUnitId),
      this.d.indexer.hubVault(params.destinationStorageUnitId),
      this.config(),
    ])

    const tx = new Transaction()
    // Every item drawn from the hangar shares one borrow of its cap.
    const borrows = new HangarCapBorrows(this.d.suiClient, tx, this.d.ids)
    const cargo = []
    for (const item of params.cargo) {
      cargo.push(
        await sourceItemBalance(this.d.suiClient, tx, this.d.ids, {
          owner,
          collectionId: pickup.collectionId,
          assetId: BigInt(item.assetId),
          quantity: item.quantity,
          hangar:
            params.useHangar === false
              ? undefined
              : {
                  ssuObjectId: toSsuObjectId(params.pickupStorageUnitId),
                  vaultConfigId: pickup.vaultConfigId,
                },
          borrows,
        }),
      )
    }
    borrows.returnAll()

    // The posting fee, exactly as configured: split off the reward funding
    // when it is in the job's currency, funded separately otherwise.
    const fee = config.postFee
    const feeCoinType = fee?.currency.coinType ?? NO_FEE_COIN
    const feeInCurrency = !!fee && sameType(feeCoinType, currency)
    const reward = await prepareCoinInput(
      this.d.suiClient,
      tx,
      owner,
      currency,
      params.reward + (feeInCurrency ? fee!.amount : 0n),
    )
    const postFee = !fee
      ? tx.moveCall({
          target: '0x2::coin::zero',
          typeArguments: [feeCoinType],
        })[0]
      : feeInCurrency
        ? tx.splitCoins(reward, [tx.pure.u64(fee.amount)])[0]
        : await prepareCoinInput(
            this.d.suiClient,
            tx,
            owner,
            feeCoinType,
            fee.amount,
          )

    const want = params.want ?? params.cargo
    const cap = postAgreement(tx, h, {
      currency,
      cargo,
      reward,
      postFeeCoinType: feeCoinType,
      postFee,
      want: want.map((w) => ({
        collectionId: destination.collectionId,
        assetId: w.assetId,
        quantity: w.quantity,
      })),
      collateral: params.collateral,
      acceptWindowMs: params.acceptWindowMs,
      haulDurationMs: params.haulDurationMs,
      beneficiary: params.beneficiary,
      principals: params.principals,
    })
    tx.transferObjects([cap as any], owner)

    const res = await executeAndNormalize(executor, tx)
    return {
      digest: res.digest,
      createdObjects: res.createdObjects,
      raw: res.raw,
      agreementId:
        findCreatedObject(res, '::hauling::HaulingAgreement<')?.objectId ??
        null,
      capId: findCreatedObject(res, '::hauling::ListerCap')?.objectId ?? null,
    }
  }

  /**
   * Accept an open agreement: lock the collateral from the wallet and take
   * the cargo. Claim gates are satisfied as the gateway's claim plan for this
   * player says — directly, or through an organization whose board they sit
   * on.
   * @throws `ValidationFailed` when not on the claim list or a requirement
   *   can't be satisfied; `AgreementNotFound`; `InsufficientBalance`.
   */
  async accept(params: { agreementId: string }): Promise<TxResult> {
    const owner = this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    const a = await this.agreement({
      agreementId: params.agreementId,
      viewer: owner,
    })
    requireStatus(a, ['open'], 'accept')
    const steps = (a.viewer?.claimPlan?.steps ?? []).map((s) => ({
      reqIndex: s.reqIndex,
      action: s.action,
      orgId: s.orgId,
      typeName: s.typeName,
    }))
    if (a.claimGated && !a.viewer?.claimPlan) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        'The agreement is claim-gated but the gateway returned no claim plan for this address.',
      )
    }
    const tx = new Transaction()
    const collateral = await prepareCoinInput(
      this.d.suiClient,
      tx,
      owner,
      a.currency.coinType,
      a.collateral,
    )
    const cargo = acceptAgreement(tx, h, {
      agreementId: a.agreementId,
      currency: a.currency.coinType,
      collateral,
      steps,
    })
    payAll(tx, h, cargo, owner)
    return txResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Hand in the wanted items at the destination, before the deadline: wallet
   * receipts in each item's collection first, then the hangar at the
   * destination hub (`useHangar`, default true).
   * @throws `ValidationFailed` when the agreement isn't accepted;
   *   `InsufficientBalance`; `AgreementNotFound`.
   */
  async deliver(params: {
    agreementId: string
    useHangar?: boolean
  }): Promise<TxResult> {
    const owner = this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    const a = await this.agreement({ agreementId: params.agreementId })
    requireStatus(a, ['accepted'], 'deliver')
    const tx = new Transaction()
    const borrows = new HangarCapBorrows(this.d.suiClient, tx, this.d.ids)
    const delivered = []
    for (const w of a.want) {
      const hub =
        w.hubId && params.useHangar !== false
          ? await this.d.indexer.hubVault(w.hubId)
          : null
      delivered.push(
        await sourceItemBalance(this.d.suiClient, tx, this.d.ids, {
          owner,
          collectionId: w.collectionId,
          assetId: BigInt(w.assetId),
          quantity: w.quantity,
          hangar:
            hub && w.hubId
              ? {
                  ssuObjectId: toSsuObjectId(w.hubId),
                  vaultConfigId: hub.vaultConfigId,
                }
              : undefined,
          borrows,
        }),
      )
    }
    borrows.returnAll()
    deliverAgreement(tx, h, {
      agreementId: a.agreementId,
      currency: a.currency.coinType,
      delivered,
    })
    return txResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Cancel an open agreement (the sender holds its lister cap): the cargo and
   * reward come back to the sender.
   * @throws `ValidationFailed` once accepted; `AgreementNotFound`.
   */
  async cancel(params: { agreementId: string }): Promise<TxResult> {
    const owner = this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    const a = await this.agreement({ agreementId: params.agreementId })
    requireStatus(a, ['open', 'lapsed'], 'cancel')
    const tx = new Transaction()
    cancelAgreement(tx, h, {
      agreementId: a.agreementId,
      capId: a.capId,
      currency: a.currency.coinType,
      owner,
    })
    return txResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Default an agreement past its delivery deadline (permissionless): the
   * reward and the hauler's collateral go to whoever the terms pay.
   * @throws `ValidationFailed` before the deadline; `AgreementNotFound`.
   */
  async default(params: { agreementId: string }): Promise<TxResult> {
    return this.end(params.agreementId, 'default', ['overdue'])
  }

  /**
   * Give up an accepted job before its deadline (the hauler only): the same
   * payout as a default, now instead of later.
   * @throws `ValidationFailed` when not accepted; `AgreementNotFound`.
   */
  async forfeit(params: { agreementId: string }): Promise<TxResult> {
    return this.end(params.agreementId, 'forfeit', ['accepted'])
  }

  /**
   * Collect what the lister cap received when the agreement ended: the
   * wanted items after a delivery, the reward and collateral after a default
   * or forfeit, the cargo and reward after a lapse.
   * @throws `ValidationFailed` when there are no proceeds to collect;
   *   `AgreementNotFound`.
   */
  async collect(params: { agreementId: string }): Promise<TxResult> {
    const owner = this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    const a = await this.agreement({ agreementId: params.agreementId })
    if (!a.proceeds || a.proceeds.collected) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        a.proceeds
          ? 'These proceeds were already collected.'
          : `Nothing to collect yet: the agreement is ${a.status}.`,
      )
    }
    const tx = new Transaction()
    collectProceeds(tx, h, {
      capId: a.capId,
      proceedsId: a.proceeds.proceedsId,
      currency: a.currency.coinType,
      owner,
      delivered: a.status === 'delivered',
    })
    return txResult(await executeAndNormalize(executor, tx))
  }

  /**
   * Delete a spent lister cap that doesn't receive proceeds (it pays a fixed
   * beneficiary), once the agreement has ended.
   * @throws `ValidationFailed` when the cap receives proceeds or is gone.
   */
  async deleteCap(params: { agreementId: string }): Promise<TxResult> {
    this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    const a = await this.agreement({ agreementId: params.agreementId })
    if (a.cap.receivesProceeds || a.cap.endedKind) {
      throw new TriexClientError(
        TriexError.ValidationFailed,
        a.cap.endedKind
          ? `The lister cap is already ${a.cap.endedKind}.`
          : 'This lister cap receives proceeds: collect them instead of deleting it.',
      )
    }
    const tx = new Transaction()
    deleteListerCap(tx, h, a.capId)
    return txResult(await executeAndNormalize(executor, tx))
  }

  private async end(
    agreementId: string,
    kind: 'default' | 'forfeit',
    statuses: string[],
  ): Promise<TxResult> {
    this.d.requireAddress()
    const executor = this.d.requireExecutor()
    const h = haulingIds(this.d.ids)
    const a = await this.agreement({ agreementId })
    requireStatus(a, statuses, kind)
    const tx = new Transaction()
    endAgreement(tx, h, {
      agreementId: a.agreementId,
      currency: a.currency.coinType,
      kind,
    })
    return txResult(await executeAndNormalize(executor, tx))
  }
}

function requireStatus(
  a: HaulingAgreementDetail,
  allowed: string[],
  action: string,
): void {
  if (!allowed.includes(a.status)) {
    throw new TriexClientError(
      TriexError.ValidationFailed,
      `Cannot ${action} an agreement that is ${a.status} (needs ${allowed.join(' or ')}).`,
    )
  }
}

function sameType(a: string, b: string): boolean {
  try {
    return normalizeStructTag(a) === normalizeStructTag(b)
  } catch {
    return a === b
  }
}

function txResult(res: {
  digest: string
  createdObjects: TxResult['createdObjects']
  raw: unknown
}): TxResult {
  return {
    digest: res.digest,
    createdObjects: res.createdObjects,
    raw: res.raw,
  }
}
