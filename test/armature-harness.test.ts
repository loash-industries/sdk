import {
  canComposite,
  evaluatePaths,
  MAX_COMPOSITE_STEPS,
  type OuCapabilities,
  type OuProposalAction,
  selectStrategy,
} from '../src/armature/harness'
import type { DaoGovernance, ProposalConfig } from '../src/armature/governance'
import { singleVoteExecutable } from '../src/armature/governance'
import type { OuExecContext } from '../src/armature/types'

const ALICE = '0xAAAA'
const BOB = '0xbbbb'
const CAROL = '0xcccc'

const config = (over: Partial<ProposalConfig> = {}): ProposalConfig => ({
  quorum: 1,
  approvalThreshold: 5000,
  proposeThreshold: 0,
  expiryMs: 3_600_000,
  executionDelayMs: 0,
  cooldownMs: 0,
  composableAllowed: false,
  ...over,
})

/** A unit with a parent linkage — both control and own paths available. */
const ctxWithParent = (over: Partial<OuExecContext> = {}): OuExecContext => ({
  daoId: '0xchild',
  board: [ALICE, BOB],
  emergencyFreezeId: '0xchild-freeze',
  parent: {
    daoId: '0xparent',
    board: [CAROL],
    emergencyFreezeId: '0xparent-freeze',
    capVaultId: '0xparent-caps',
    controlCapId: '0xcontrol-cap',
  },
  ...over,
})

const ctxRoot: OuExecContext = {
  daoId: '0xroot',
  board: [ALICE],
  emergencyFreezeId: '0xroot-freeze',
}

const noop = () => undefined
const payload = () => ({}) as never

/** An action with whichever adapters the test needs. */
function action(opts: {
  own?: boolean
  control?: boolean
  fallbackPolicy?: OuProposalAction['fallbackPolicy']
}): OuProposalAction {
  return {
    kind: 'test',
    own: opts.own
      ? {
          typeKey: 'Own',
          payloadMoveType: '0x2::own::Own',
          buildPayload: payload,
          buildExecute: noop,
        }
      : undefined,
    control: opts.control
      ? {
          typeKey: 'Control',
          payloadMoveType: '0x2::control::Control',
          buildPayload: payload,
          buildExecute: noop,
        }
      : undefined,
    fallbackPolicy: opts.fallbackPolicy,
  }
}

const caps = (over: Partial<OuCapabilities> = {}): OuCapabilities => ({
  ownConfig: null,
  controlConfig: null,
  ...over,
})

describe('singleVoteExecutable', () => {
  it('is a quorum question, not a role question', () => {
    // Board of 5: 1bps × 5 = 5 ≤ 10000 → one vote is enough.
    expect(singleVoteExecutable(5, config({ quorum: 1 }))).toBe(true)
    // Same board at 50%: 5000 × 5 = 25000 > 10000 → needs a real vote.
    expect(singleVoteExecutable(5, config({ quorum: 5000 }))).toBe(false)
    // A two-member board at 50% is exactly on the line and passes.
    expect(singleVoteExecutable(2, config({ quorum: 5000 }))).toBe(true)
    // Three is over it.
    expect(singleVoteExecutable(3, config({ quorum: 5000 }))).toBe(false)
  })

  it('refuses atomic execution when the config imposes a delay', () => {
    expect(
      singleVoteExecutable(1, config({ quorum: 1, executionDelayMs: 1 })),
    ).toBe(false)
  })

  it('is false for an empty board', () => {
    expect(singleVoteExecutable(0, config())).toBe(false)
  })
})

describe('selectStrategy — the ladder', () => {
  it('A beats B: own-execute wins when both immediate paths are viable', () => {
    const d = selectStrategy(
      action({ own: true, control: true }),
      ctxWithParent({ board: [ALICE] }),
      caps({ ownConfig: config(), controlConfig: config() }),
      ALICE,
    )
    expect(d).toMatchObject({
      blocked: false,
      strategy: 'own-execute',
      immediate: true,
      voterBoardSize: 1,
    })
  })

  it('B when the caller sits on the parent board, not the child', () => {
    const d = selectStrategy(
      action({ own: true, control: true }),
      ctxWithParent(),
      caps({ ownConfig: config(), controlConfig: config() }),
      CAROL,
    )
    expect(d).toMatchObject({ strategy: 'control-execute', immediate: true })
  })

  it('C when the caller is on the own board but quorum blocks a lone vote', () => {
    const d = selectStrategy(
      action({ own: true }),
      ctxWithParent(),
      caps({ ownConfig: config({ quorum: 6600 }) }),
      ALICE,
    )
    expect(d).toMatchObject({
      strategy: 'own-propose',
      immediate: false,
      voterBoardSize: 2,
    })
  })

  it('D when only the parent path remains and it cannot execute atomically', () => {
    const bigParent = ctxWithParent()
    bigParent.parent!.board = [CAROL, '0xdddd', '0xeeee']
    const d = selectStrategy(
      action({ control: true }),
      bigParent,
      caps({ controlConfig: config({ quorum: 5000 }) }),
      CAROL,
    )
    expect(d).toMatchObject({ strategy: 'control-propose', immediate: false })
  })

  it('prefers an immediate parent path over a slow own path', () => {
    // Alice sits on both; own quorum blocks her, parent quorum does not.
    const d = selectStrategy(
      action({ own: true, control: true }),
      ctxWithParent({ parent: { ...ctxWithParent().parent!, board: [ALICE] } }),
      caps({ ownConfig: config({ quorum: 6600 }), controlConfig: config() }),
      ALICE,
    )
    expect(d).toMatchObject({ strategy: 'control-execute', immediate: true })
  })

  it('single-vote-only blocks rather than degrading to a proposal', () => {
    const d = selectStrategy(
      action({ own: true, fallbackPolicy: 'single-vote-only' }),
      ctxWithParent(),
      caps({ ownConfig: config({ quorum: 6600 }) }),
      ALICE,
    )
    expect(d).toEqual({
      blocked: true,
      code: 'needs-slow-tier',
      reason: expect.stringContaining('does not allow a governance proposal'),
    })
  })

  it('blocks a non-member with not-member, on either board', () => {
    const d = selectStrategy(
      action({ own: true, control: true }),
      ctxWithParent(),
      caps({ ownConfig: config(), controlConfig: config() }),
      '0xstranger',
    )
    expect(d).toMatchObject({ blocked: true, code: 'not-member' })
  })

  it('blocks a member with not-permitted when the type is not enabled', () => {
    const d = selectStrategy(
      action({ own: true }),
      ctxWithParent(),
      caps(), // no configs at all → type not enabled anywhere
      ALICE,
    )
    expect(d).toMatchObject({ blocked: true, code: 'not-permitted' })
  })

  it('blocks a control-only action on a root unit — there is no parent', () => {
    const d = selectStrategy(
      action({ control: true }),
      ctxRoot,
      caps({ controlConfig: config() }),
      ALICE,
    )
    // Alice IS on the root board, so this is not-permitted, not not-member.
    expect(d).toMatchObject({ blocked: true, code: 'not-permitted' })
  })

  it('matches board membership case-insensitively', () => {
    const d = selectStrategy(
      action({ own: true }),
      ctxRoot,
      caps({ ownConfig: config() }),
      ALICE.toLowerCase(),
    )
    expect(d).toMatchObject({ strategy: 'own-execute' })
  })

  it('undefined caller is never on any board', () => {
    const d = selectStrategy(
      action({ own: true }),
      ctxRoot,
      caps({ ownConfig: config() }),
      undefined,
    )
    expect(d).toMatchObject({ blocked: true, code: 'not-member' })
  })
})

describe('evaluatePaths', () => {
  it('always returns all four candidates, in priority order', () => {
    const paths = evaluatePaths(
      action({ own: true, control: true }),
      ctxWithParent(),
      caps({ ownConfig: config() }),
      ALICE,
    )
    expect(paths.map((p) => p.strategy)).toEqual([
      'own-execute',
      'control-execute',
      'own-propose',
      'control-propose',
    ])
    expect(paths.map((p) => p.tier)).toEqual([
      'immediate',
      'immediate',
      'slow',
      'slow',
    ])
  })

  it('the winner is the first viable candidate — trace cannot drift', () => {
    const a = action({ own: true, control: true })
    const ctx = ctxWithParent()
    const c = caps({ ownConfig: config({ quorum: 6600 }) })
    const paths = evaluatePaths(a, ctx, c, ALICE)
    const decision = selectStrategy(a, ctx, c, ALICE)

    const firstViable = paths.find((p) => p.viable)
    expect(decision.blocked).toBe(false)
    if (!decision.blocked) {
      expect(decision.strategy).toBe(firstViable?.strategy)
    }
  })

  it('explains why each immediate path is unavailable', () => {
    const paths = evaluatePaths(
      action({ own: true }),
      ctxWithParent(),
      caps({ ownConfig: config({ quorum: 6600 }) }),
      ALICE,
    )
    expect(paths[0].detail).toContain('quorum 6600bps × 2 members > 10000')
    expect(paths[1].detail).toBe('no control adapter / parent unit')

    const delayed = evaluatePaths(
      action({ own: true }),
      ctxRoot,
      caps({ ownConfig: config({ executionDelayMs: 60_000 }) }),
      ALICE,
    )
    expect(delayed[0].detail).toContain('execution delay 60000ms')

    const stranger = evaluatePaths(
      action({ own: true }),
      ctxRoot,
      caps({ ownConfig: config() }),
      '0xnope',
    )
    expect(stranger[0].detail).toBe('caller not on that board')

    const unenabled = evaluatePaths(
      action({ own: true }),
      ctxRoot,
      caps(),
      ALICE,
    )
    expect(unenabled[0].detail).toBe('type not enabled on that DAO')
  })
})

describe('canComposite', () => {
  const gov = (over: Partial<DaoGovernance> = {}): DaoGovernance => ({
    enabledTypes: new Set(['Composite', 'Own']),
    configs: new Map([['Own', config({ composableAllowed: true })]]),
    typeBindings: new Map(),
    ...over,
  })
  const composable = () => action({ own: true })

  it('bundles two composable own actions', () => {
    expect(canComposite([composable(), composable()], gov())).toEqual({
      eligible: true,
    })
  })

  it('refuses a cart of one — nothing to bundle', () => {
    expect(canComposite([composable()], gov())).toEqual({
      eligible: false,
      reason: 'single-action',
    })
    expect(canComposite([], gov())).toEqual({
      eligible: false,
      reason: 'single-action',
    })
  })

  it('refuses more steps than the chain accepts', () => {
    const many = Array.from({ length: MAX_COMPOSITE_STEPS + 1 }, composable)
    expect(canComposite(many, gov())).toEqual({
      eligible: false,
      reason: 'too-many-steps',
    })
    // Exactly the limit is fine.
    expect(
      canComposite(
        Array.from({ length: MAX_COMPOSITE_STEPS }, composable),
        gov(),
      ),
    ).toEqual({ eligible: true })
  })

  it('refuses when the unit has not enabled Composite', () => {
    expect(
      canComposite(
        [composable(), composable()],
        gov({ enabledTypes: new Set() }),
      ),
    ).toEqual({ eligible: false, reason: 'composite-disabled' })
    expect(canComposite([composable(), composable()], undefined)).toEqual({
      eligible: false,
      reason: 'composite-disabled',
    })
  })

  it('refuses a step whose type is not composable_allowed', () => {
    expect(
      canComposite(
        [composable(), composable()],
        gov({
          configs: new Map([['Own', config({ composableAllowed: false })]]),
        }),
      ),
    ).toEqual({ eligible: false, reason: 'step-not-composable' })
  })

  it('refuses a control-only action — composites run the own pipeline', () => {
    expect(
      canComposite([composable(), action({ control: true })], gov()),
    ).toEqual({ eligible: false, reason: 'step-not-composable' })
  })
})
