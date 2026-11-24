import { z } from 'zod'
import { bigintString, openEnum } from '../schemas'

/**
 * Hauling agreements — the gateway's `/v1/agreements*` reads, wire → domain.
 *
 * A hauling agreement is an on-chain job: a lister escrows a reward (and asks
 * for collateral) for moving cargo from one hub to another; a hauler accepts,
 * delivers before the deadline and is paid, or defaults and forfeits the
 * collateral. Contracts: armature-vault `packages/composites/hauling_agreements`.
 *
 * Conventions match the rest of the SDK: camelCase fields, amounts (raw base
 * units) as `bigint`, epoch-ms timestamps as numbers, and spec enums as open
 * enums so a status added upstream never turns a read into an
 * `UnexpectedResponse`.
 */

/** Every agreement status the indexer reports. */
export const AGREEMENT_STATUSES = [
  'open',
  'lapsed',
  'accepted',
  'overdue',
  'delivered',
  'defaulted',
  'forfeited',
  'cancelled',
  'closed_lapsed',
] as const

/** The parts an address can play in an agreement. */
export const AGREEMENT_ROLES = [
  'lister',
  'cap_holder',
  'beneficiary',
  'hauler',
  'claimed_via_org',
] as const

/** Whether an address can accept an agreement. */
export const AGREEMENT_ELIGIBILITY = [
  'eligible',
  'ineligible',
  'unknown',
] as const

/** The next steps the player to-do list can name. */
export const AGREEMENT_ACTIONS = [
  'collect_proceeds',
  'delete_cap',
  'cancel_lapsed',
  'deliver',
  'default',
] as const

/** Events on an agreement's timeline. */
export const AGREEMENT_EVENTS = [
  'posted',
  'accepted',
  'claimed',
  'delivered',
  'defaulted',
  'forfeited',
  'cancelled',
  'closed_lapsed',
  'proceeds_collected',
  'cap_deleted',
] as const

// ─── Shared parts ────────────────────────────────────────────────────────────

/** A coin type with its registry metadata (null when unknown). */
export const HaulingCoinSchema = z
  .object({
    coin_type: z.string(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    decimals: z.number().nullable(),
  })
  .transform((v) => ({
    coinType: v.coin_type,
    symbol: v.symbol,
    name: v.name,
    decimals: v.decimals,
  }))

/** An amount of one currency. */
export const HaulingAmountSchema = z
  .object({ currency: HaulingCoinSchema, amount: bigintString })
  .transform((v) => ({ currency: v.currency, amount: v.amount }))

/** A wallet, with its character name when one is known. */
export const HaulingPartySchema = z
  .object({ address: z.string(), character_name: z.string().nullable() })
  .transform((v) => ({ address: v.address, characterName: v.character_name }))

const HaulingOrgRefSchema = z
  .object({
    org_id: z.string(),
    name: z.string().nullable(),
    root_org_id: z.string(),
    root_org_name: z.string().nullable(),
  })
  .transform((v) => ({
    orgId: v.org_id,
    name: v.name,
    rootOrgId: v.root_org_id,
    rootOrgName: v.root_org_name,
  }))

/** Who an agreement was posted on behalf of (a trusted wrapper, e.g. an org). */
const HaulingEntitySchema = z
  .object({
    kind: z.string(),
    id: z.string(),
    trusted: z.boolean(),
    org: HaulingOrgRefSchema.nullable(),
  })
  .transform((v) => ({
    kind: v.kind,
    id: v.id,
    trusted: v.trusted,
    org: v.org,
  }))

/** The identity a hauler accepted under (a machine key, a character, ...). */
const HaulingIdentitySchema = z
  .object({ id: z.string(), rule: z.string().nullable(), trusted: z.boolean() })
  .transform((v) => ({ id: v.id, rule: v.rule, trusted: v.trusted }))

/** One cargo or wanted line: an item stack at a hub. */
export const HaulingItemsSchema = z
  .object({
    collection_id: z.string(),
    asset_id: z.string(),
    quantity: bigintString,
    hub_id: z.string().nullable(),
    hub_name: z.string().nullable(),
    verified: z.boolean(),
  })
  .transform((v) => ({
    collectionId: v.collection_id,
    assetId: v.asset_id,
    quantity: v.quantity,
    /** The hub the stack is at (cargo) or must reach (want); null if unlinked. */
    hubId: v.hub_id,
    hubName: v.hub_name,
    /** The indexer matched the collection to a live hub vault. */
    verified: v.verified,
  }))

const ClaimPlanStepSchema = z
  .object({
    req_index: z.number(),
    rule: openEnum(['claim', 'unknown'] as const),
    type_name: z.string(),
    is_identity_rule: z.boolean(),
    action: openEnum([
      'satisfy_directly',
      'satisfy',
      'not_satisfiable',
      'unknown',
    ] as const),
    org_id: z.string().nullable(),
  })
  .transform((v) => ({
    reqIndex: v.req_index,
    rule: v.rule,
    typeName: v.type_name,
    isIdentityRule: v.is_identity_rule,
    /**
     * `satisfy_directly`: the address is listed itself; `satisfy`: through
     * `orgId`, an organization whose board it sits on; `not_satisfiable`: it
     * cannot meet this gate.
     */
    action: v.action,
    orgId: v.org_id,
  }))

/** How (and whether) an address can meet every accept requirement. */
export const HaulingClaimPlanSchema = z
  .object({
    eligibility: openEnum(AGREEMENT_ELIGIBILITY),
    steps: z.array(ClaimPlanStepSchema),
  })
  .transform((v) => ({ eligibility: v.eligibility, steps: v.steps }))

// ─── Agreements ──────────────────────────────────────────────────────────────

const agreementShape = {
  agreement_id: z.string(),
  status: openEnum(AGREEMENT_STATUSES),
  posted_at: z.number(),
  accept_deadline_at: z.number(),
  haul_duration_ms: z.number(),
  lister: HaulingPartySchema,
  beneficiary: HaulingPartySchema,
  pays_cap_holder: z.boolean(),
  on_behalf_of: HaulingEntitySchema.nullable(),
  cargo: z.array(HaulingItemsSchema),
  want: z.array(HaulingItemsSchema),
  currency: HaulingCoinSchema,
  reward: bigintString,
  collateral: bigintString,
  delivery_fee_bps: z.number(),
  claim_gated: z.boolean(),
  has_other_rules: z.boolean(),
  hauler: HaulingPartySchema.nullable(),
  hauler_identity: HaulingIdentitySchema.nullable(),
  accepted_at: z.number().nullable(),
  delivery_deadline_at: z.number().nullable(),
  closed_at: z.number().nullable(),
  closed_by: HaulingPartySchema.nullable(),
  hauler_reward: bigintString.nullable(),
  delivery_fee: bigintString.nullable(),
  refunded_to: z.string().nullable(),
  cap_id: z.string(),
  posted_tx_digest: z.string(),
  accepted_tx_digest: z.string().nullable(),
  closed_tx_digest: z.string().nullable(),
  eligibility: openEnum(AGREEMENT_ELIGIBILITY).optional(),
  viewer_roles: z.array(openEnum(AGREEMENT_ROLES)).optional(),
}

type AgreementWire = z.infer<z.ZodObject<typeof agreementShape>>

function agreement(v: AgreementWire) {
  return {
    agreementId: v.agreement_id,
    /**
     * `lapsed` (open past its accept deadline) and `overdue` (accepted past
     * its delivery deadline) are derived from wall-clock time; the others are
     * on-chain outcomes.
     */
    status: v.status,
    /** Epoch ms. */
    postedAt: v.posted_at,
    /** Epoch ms; the agreement can no longer be accepted after this. */
    acceptDeadlineAt: v.accept_deadline_at,
    /** How long a hauler has to deliver once they accept, in ms. */
    haulDurationMs: v.haul_duration_ms,
    lister: v.lister,
    /** Who receives the wanted items / proceeds. */
    beneficiary: v.beneficiary,
    /** Proceeds go to whoever holds the lister cap, not a fixed beneficiary. */
    paysCapHolder: v.pays_cap_holder,
    onBehalfOf: v.on_behalf_of,
    /** What the hauler moves, from its source hub. */
    cargo: v.cargo,
    /** What the lister wants delivered, to its destination hub. */
    want: v.want,
    currency: v.currency,
    /** Escrowed reward, raw base units of `currency`. */
    reward: v.reward,
    /** Collateral the hauler locks on accept, raw base units. */
    collateral: v.collateral,
    deliveryFeeBps: v.delivery_fee_bps,
    /** Accepting is restricted by claim gates (see `claimPlan` / requirements). */
    claimGated: v.claim_gated,
    /** Accept requirements beyond claim gates the indexer cannot evaluate. */
    hasOtherRules: v.has_other_rules,
    hauler: v.hauler,
    haulerIdentity: v.hauler_identity,
    acceptedAt: v.accepted_at,
    /** Epoch ms; null until accepted. */
    deliveryDeadlineAt: v.delivery_deadline_at,
    closedAt: v.closed_at,
    closedBy: v.closed_by,
    /** What the hauler was paid on delivery (reward minus the delivery fee). */
    haulerReward: v.hauler_reward,
    deliveryFee: v.delivery_fee,
    refundedTo: v.refunded_to,
    /** The lister cap object — it collects proceeds and can cancel. */
    capId: v.cap_id,
    postedTxDigest: v.posted_tx_digest,
    acceptedTxDigest: v.accepted_tx_digest,
    closedTxDigest: v.closed_tx_digest,
    /** Whether the `claimableBy` / `viewer` address can accept; set on request. */
    eligibility: v.eligibility ?? null,
    /** The parts the queried address plays; set on player and viewer reads. */
    viewerRoles: v.viewer_roles ?? [],
  }
}

/** One hauling agreement, as list reads return it. */
export const HaulingAgreementSchema = z
  .object(agreementShape)
  .transform(agreement)

/** A page of agreements. */
export const HaulingAgreementPageSchema = z
  .object({
    data: z.array(HaulingAgreementSchema),
    next_cursor: z.string().nullable(),
    evaluated_at: z.number(),
  })
  .transform((v) => ({
    agreements: v.data,
    nextCursor: v.next_cursor,
    /** Epoch ms the time-derived statuses (`lapsed`, `overdue`) were judged at. */
    evaluatedAt: v.evaluated_at,
  }))

/** An open agreement an address can accept, with how it would claim. */
export const ClaimableAgreementSchema = z
  .object({ ...agreementShape, claim_plan: HaulingClaimPlanSchema })
  .transform((v) => ({ ...agreement(v), claimPlan: v.claim_plan }))

/** A page of agreements an address can accept. */
export const ClaimableAgreementPageSchema = z
  .object({
    data: z.array(ClaimableAgreementSchema),
    next_cursor: z.string().nullable(),
    evaluated_at: z.number(),
  })
  .transform((v) => ({
    agreements: v.data,
    nextCursor: v.next_cursor,
    evaluatedAt: v.evaluated_at,
  }))

// ─── Agreement detail ────────────────────────────────────────────────────────

const PrincipalSchema = z
  .object({
    kind: openEnum(['player', 'machine', 'ou'] as const),
    id: z.string(),
    name: z.string().nullable(),
  })
  .transform((v) => ({ kind: v.kind, id: v.id, name: v.name }))

const RequirementSchema = z
  .object({
    req_index: z.number(),
    rule: openEnum(['claim', 'unknown'] as const),
    type_name: z.string(),
    is_identity_rule: z.boolean(),
    principals: z.array(PrincipalSchema),
    data: z.string().nullable(),
  })
  .transform((v) => ({
    reqIndex: v.req_index,
    /** `claim`: a claim gate listing `principals`; `unknown`: a rule kept raw. */
    rule: v.rule,
    typeName: v.type_name,
    isIdentityRule: v.is_identity_rule,
    /** Players, machine keys and organizations the gate admits. */
    principals: v.principals,
    /** The rule's raw data (base64) when the indexer cannot decode it. */
    data: v.data,
  }))

const ObserverSchema = z
  .object({
    kind: z.string(),
    instance_id: z.string(),
    fee: z
      .object({
        collection_id: z.string(),
        asset_id: z.string(),
        quantity: bigintString,
      })
      .nullable(),
  })
  .transform((v) => ({
    kind: v.kind,
    instanceId: v.instance_id,
    fee: v.fee
      ? {
          collectionId: v.fee.collection_id,
          assetId: v.fee.asset_id,
          quantity: v.fee.quantity,
        }
      : null,
  }))

const CapSchema = z
  .object({
    cap_id: z.string(),
    owner_kind: openEnum([
      'address',
      'object',
      'wrapped',
      'shared',
      'immutable',
      'party',
    ] as const).nullable(),
    owner: z.string().nullable(),
    owner_name: z.string().nullable(),
    receives_proceeds: z.boolean(),
    ended_kind: openEnum([
      'cancelled',
      'collected',
      'deleted',
    ] as const).nullable(),
  })
  .transform((v) => ({
    capId: v.cap_id,
    ownerKind: v.owner_kind,
    owner: v.owner,
    ownerName: v.owner_name,
    receivesProceeds: v.receives_proceeds,
    /** How the cap's life ended; null while it is live. */
    endedKind: v.ended_kind,
  }))

const ProceedsSchema = z
  .object({
    proceeds_id: z.string(),
    collected: z.boolean(),
    collected_by: HaulingPartySchema.nullable(),
  })
  .transform((v) => ({
    proceedsId: v.proceeds_id,
    collected: v.collected,
    collectedBy: v.collected_by,
  }))

const PostFeeSchema = z
  .object({ currency: HaulingCoinSchema, amount: bigintString })
  .transform((v) => ({ currency: v.currency, amount: v.amount }))

const FeesSchema = z
  .object({
    post_fee: PostFeeSchema.nullable(),
    delivery_fee_bps: z.number(),
    delivery_fee: bigintString.nullable(),
    treasury: z.string(),
  })
  .transform((v) => ({
    postFee: v.post_fee,
    deliveryFeeBps: v.delivery_fee_bps,
    deliveryFee: v.delivery_fee,
    treasury: v.treasury,
  }))

const ClaimSchema = z
  .object({
    actor: HaulingPartySchema,
    principal: PrincipalSchema,
    tx_digest: z.string(),
  })
  .transform((v) => ({
    actor: v.actor,
    /** The gate principal the actor claimed as (themselves, a key, an org). */
    principal: v.principal,
    txDigest: v.tx_digest,
  }))

const TimelineEventSchema = z
  .object({
    kind: openEnum(AGREEMENT_EVENTS),
    actor: HaulingPartySchema,
    at: z.number(),
    checkpoint: bigintString,
    tx_digest: z.string(),
  })
  .transform((v) => ({
    kind: v.kind,
    actor: v.actor,
    at: v.at,
    checkpoint: v.checkpoint,
    txDigest: v.tx_digest,
  }))

const ViewerSchema = z
  .object({
    address: z.string(),
    roles: z.array(openEnum(AGREEMENT_ROLES)),
    claim_plan: HaulingClaimPlanSchema.nullable(),
  })
  .transform((v) => ({
    address: v.address,
    roles: v.roles,
    claimPlan: v.claim_plan,
  }))

/** One agreement in full. */
export const HaulingAgreementDetailSchema = z
  .object({
    ...agreementShape,
    requirements: z.array(RequirementSchema),
    observer: ObserverSchema.nullable(),
    cap: CapSchema,
    proceeds: ProceedsSchema.nullable(),
    fees: FeesSchema,
    claims: z.array(ClaimSchema),
    timeline: z.array(TimelineEventSchema),
    viewer: ViewerSchema.nullable(),
    evaluated_at: z.number(),
  })
  .transform((v) => ({
    ...agreement(v),
    /** Accept requirements: claim gates with their principals, others raw. */
    requirements: v.requirements,
    observer: v.observer,
    cap: v.cap,
    proceeds: v.proceeds,
    fees: v.fees,
    claims: v.claims,
    timeline: v.timeline,
    /** The `viewer` address's roles and claim plan; null without one. */
    viewer: v.viewer,
    evaluatedAt: v.evaluated_at,
  }))

// ─── Player to-do list ───────────────────────────────────────────────────────

const ActionSchema = z
  .object({
    action: openEnum(AGREEMENT_ACTIONS),
    move_call: z.string(),
    type_argument: z.string(),
    agreement_id: z.string(),
    cap_id: z.string().nullable(),
    proceeds_id: z.string().nullable(),
    due_at: z.number().nullable(),
    agreement: HaulingAgreementSchema,
  })
  .transform((v) => ({
    action: v.action,
    /** The `hauling` function to call, e.g. `hauling::deliver`. */
    moveCall: v.move_call,
    /** The agreement's currency type — the call's type argument. */
    typeArgument: v.type_argument,
    agreementId: v.agreement_id,
    capId: v.cap_id,
    proceedsId: v.proceeds_id,
    /** Epoch ms the action must happen by (delivery); null when not timed. */
    dueAt: v.due_at,
    agreement: v.agreement,
  }))

/** What an address can do next across its agreements. */
export const HaulingActionPageSchema = z
  .object({
    data: z.array(ActionSchema),
    next_cursor: z.string().nullable(),
    evaluated_at: z.number(),
  })
  .transform((v) => ({
    actions: v.data,
    nextCursor: v.next_cursor,
    evaluatedAt: v.evaluated_at,
  }))

// ─── Protocol config, stats & reputation ─────────────────────────────────────

const ConfigChangeSchema = z
  .object({
    currencies: z.array(z.string()),
    post_fee_currency: z.string().nullable(),
    post_fee_amount: bigintString.nullable(),
    delivery_fee_bps: z.number(),
    treasury: z.string(),
    updated_at: z.number(),
    updated_by: z.string(),
    tx_digest: z.string(),
  })
  .transform((v) => ({
    currencies: v.currencies,
    postFeeCurrency: v.post_fee_currency,
    postFeeAmount: v.post_fee_amount,
    deliveryFeeBps: v.delivery_fee_bps,
    treasury: v.treasury,
    updatedAt: v.updated_at,
    updatedBy: v.updated_by,
    txDigest: v.tx_digest,
  }))

/** What posting an agreement costs and accepts. */
export const HaulingConfigSchema = z
  .object({
    config_id: z.string(),
    currencies: z.array(HaulingCoinSchema),
    post_fee: PostFeeSchema.nullable(),
    delivery_fee_bps: z.number(),
    treasury: z.string(),
    updated_at: z.number(),
    history: z.array(ConfigChangeSchema),
  })
  .transform((v) => ({
    /** The shared `HaulingConfig` object every post and delivery reads. */
    configId: v.config_id,
    /** Currencies a reward may be posted in. */
    currencies: v.currencies,
    /** Flat fee charged to post; null when posting is free. */
    postFee: v.post_fee,
    deliveryFeeBps: v.delivery_fee_bps,
    treasury: v.treasury,
    updatedAt: v.updated_at,
    /** Recent admin changes, newest first. */
    history: v.history,
  }))

const StatusCountsSchema = z
  .object({
    open: z.number(),
    lapsed: z.number(),
    accepted: z.number(),
    overdue: z.number(),
    delivered: z.number(),
    defaulted: z.number(),
    forfeited: z.number(),
    cancelled: z.number(),
    closed_lapsed: z.number(),
  })
  .transform((v) => ({
    open: v.open,
    lapsed: v.lapsed,
    accepted: v.accepted,
    overdue: v.overdue,
    delivered: v.delivered,
    defaulted: v.defaulted,
    forfeited: v.forfeited,
    cancelled: v.cancelled,
    closedLapsed: v.closed_lapsed,
  }))

const CurrencyStatsSchema = z
  .object({
    currency: HaulingCoinSchema,
    agreements: z.number(),
    reward_posted: bigintString,
    reward_paid: bigintString,
    delivery_fees: bigintString,
    collateral_forfeited: bigintString,
  })
  .transform((v) => ({
    currency: v.currency,
    agreements: v.agreements,
    rewardPosted: v.reward_posted,
    rewardPaid: v.reward_paid,
    deliveryFees: v.delivery_fees,
    collateralForfeited: v.collateral_forfeited,
  }))

const LaneSchema = z
  .object({
    source_hub_id: z.string(),
    source_hub_name: z.string().nullable(),
    destination_hub_id: z.string(),
    destination_hub_name: z.string().nullable(),
    agreements: z.number(),
    delivered: z.number(),
  })
  .transform((v) => ({
    sourceHubId: v.source_hub_id,
    sourceHubName: v.source_hub_name,
    destinationHubId: v.destination_hub_id,
    destinationHubName: v.destination_hub_name,
    agreements: v.agreements,
    delivered: v.delivered,
  }))

/** Protocol-wide hauling stats. */
export const HaulingStatsSchema = z
  .object({
    by_status: StatusCountsSchema,
    by_currency: z.array(CurrencyStatsSchema),
    post_fees: z.array(HaulingAmountSchema),
    lanes: z.array(LaneSchema),
    evaluated_at: z.number(),
  })
  .transform((v) => ({
    byStatus: v.by_status,
    byCurrency: v.by_currency,
    postFees: v.post_fees,
    /** The ten busiest hub-to-hub lanes. */
    lanes: v.lanes,
    evaluatedAt: v.evaluated_at,
  }))

const HaulerRecordSchema = z
  .object({
    accepted: z.number(),
    in_progress: z.number(),
    overdue: z.number(),
    delivered: z.number(),
    defaulted: z.number(),
    forfeited: z.number(),
    completion_rate: z.number().nullable(),
    net_reward: z.array(HaulingAmountSchema),
    collateral_lost: z.array(HaulingAmountSchema),
  })
  .transform((v) => ({
    accepted: v.accepted,
    inProgress: v.in_progress,
    overdue: v.overdue,
    delivered: v.delivered,
    defaulted: v.defaulted,
    forfeited: v.forfeited,
    /** delivered / finished jobs, 0–1; null before any job finishes. */
    completionRate: v.completion_rate,
    netReward: v.net_reward,
    collateralLost: v.collateral_lost,
  }))

const ListerRecordSchema = z
  .object({
    posted: z.number(),
    open: z.number(),
    lapsed: z.number(),
    in_progress: z.number(),
    delivered: z.number(),
    defaulted: z.number(),
    forfeited: z.number(),
    cancelled: z.number(),
    closed_lapsed: z.number(),
  })
  .transform((v) => ({
    posted: v.posted,
    open: v.open,
    lapsed: v.lapsed,
    inProgress: v.in_progress,
    delivered: v.delivered,
    defaulted: v.defaulted,
    forfeited: v.forfeited,
    cancelled: v.cancelled,
    closedLapsed: v.closed_lapsed,
  }))

/** An address's hauling record, as hauler and as lister. */
export const HaulingReputationSchema = z
  .object({
    address: z.string(),
    as_hauler: HaulerRecordSchema,
    as_lister: ListerRecordSchema,
    evaluated_at: z.number(),
  })
  .transform((v) => ({
    address: v.address,
    asHauler: v.as_hauler,
    asLister: v.as_lister,
    evaluatedAt: v.evaluated_at,
  }))
