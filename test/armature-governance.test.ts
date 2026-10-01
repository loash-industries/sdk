import {
  cooldownEndsAt,
  fetchDaoGovernance,
  fetchIsBoardMember,
  fetchTypeSlots,
  normalizeMoveType,
  packageAliases,
  parseTypeSlot,
  permissionFloor,
  PERMISSIONS,
  singleVoteExecutable,
  slotForType,
} from '../src/armature/governance'
import { baseConfig, mockOuChain, slotContent } from './helpers/ouChain'

const hex = (pair: string) => `0x${pair.repeat(32)}`
const OU = hex('c1')
const ALICE = hex('11')
const PKG = hex('0a')

describe('normalizeMoveType', () => {
  it('pads and prefixes every address, including type arguments', () => {
    expect(normalizeMoveType('0x2::coin::Coin<0x2::sui::SUI>')).toBe(
      `0x${'0'.repeat(63)}2::coin::Coin<0x${'0'.repeat(63)}2::sui::SUI>`,
    )
  })

  it('treats the chain’s prefix-less TypeName and the SDK form as equal', () => {
    const chain = `${'0a'.repeat(32)}::send_coin::SendCoin<${'0'.repeat(63)}2::sui::SUI>`
    expect(normalizeMoveType(chain)).toBe(
      normalizeMoveType(`${PKG}::send_coin::SendCoin<0x2::sui::SUI>`),
    )
  })

  it('does not mistake a hex-looking MODULE name for an address', () => {
    expect(normalizeMoveType('0x2::cafe::Cafe')).toBe(
      `0x${'0'.repeat(63)}2::cafe::Cafe`,
    )
  })

  it('ignores whitespace between type arguments', () => {
    expect(normalizeMoveType('0x1::m::P<0x2::a::A, 0x3::b::B>')).toBe(
      normalizeMoveType('0x1::m::P<0x2::a::A,0x3::b::B>'),
    )
  })
})

describe('TypeSlot parsing (cycle 7 BCS)', () => {
  it('decodes display key, config (bits + scope) and last execution', () => {
    const slot = parseTypeSlot(
      slotContent({
        moveType: `${PKG}::send_coin::SendCoin<0x2::sui::SUI>`,
        displayKey: 'SendCoin<0x2::sui::SUI>',
        config: {
          quorum: 5000,
          approvalThreshold: 8000,
          cooldownMs: 60_000,
          permissions: PERMISSIONS.TREASURY_WITHDRAW,
          borrowScope: ['0x2::coin::TreasuryCap<0x2::sui::SUI>'],
        },
        lastExecutedMs: 1_000,
      }),
    )
    expect(slot.displayKey).toBe('SendCoin<0x2::sui::SUI>')
    expect(slot.typeName).toBe(
      normalizeMoveType(`${PKG}::send_coin::SendCoin<0x2::sui::SUI>`),
    )
    expect(slot.config).toEqual(
      baseConfig({
        quorum: 5000,
        approvalThreshold: 8000,
        cooldownMs: 60_000,
        permissions: PERMISSIONS.TREASURY_WITHDRAW,
        borrowScope: [
          normalizeMoveType('0x2::coin::TreasuryCap<0x2::sui::SUI>'),
        ],
      }),
    )
    expect(slot.lastExecutedMs).toBe(1_000)
    expect(cooldownEndsAt(slot)).toBe(61_000)
  })
})

describe('fetchDaoGovernance', () => {
  const chain = () =>
    mockOuChain({
      [OU]: {
        members: [ALICE],
        controllerPaused: true,
        frozen: { [`${PKG}::set_board::SetBoard`]: 9_999 },
        slots: [
          { moveType: `${PKG}::set_board::SetBoard`, displayKey: 'SetBoard' },
          {
            moveType: `${PKG}::update_metadata::UpdateMetadata`,
            displayKey: 'CharterUpdate',
          },
        ],
      },
    })

  it('reads slots, root flags and the freeze in one pass', async () => {
    const gov = await fetchDaoGovernance(chain() as never, OU)
    expect([...gov.enabledTypes].sort()).toEqual(['CharterUpdate', 'SetBoard'])
    expect(gov.typeBindings.get('CharterUpdate')).toBe(
      normalizeMoveType(`${PKG}::update_metadata::UpdateMetadata`),
    )
    expect(gov.state).toMatchObject({
      status: 'active',
      controllerPaused: true,
      executionPaused: false,
      memberCount: 1,
    })
    expect(
      gov.freeze?.frozenTypes.get(
        normalizeMoveType(`${PKG}::set_board::SetBoard`),
      ),
    ).toBe(9_999)
  })

  it('finds a slot by MOVE TYPE, whatever its display key', async () => {
    const gov = await fetchDaoGovernance(chain() as never, OU)
    const slot = slotForType(gov, `${PKG}::update_metadata::UpdateMetadata`)
    expect(slot?.displayKey).toBe('CharterUpdate')
    expect(slotForType(gov, `${PKG}::nope::Nope`)).toBeUndefined()
  })

  it('maps upgraded package ids to their defining id before matching', async () => {
    const gov = await fetchDaoGovernance(chain() as never, OU)
    const current = hex('0b')
    const aliases = packageAliases([[current, PKG]])
    expect(
      slotForType(gov, `${current}::set_board::SetBoard`, { aliases })
        ?.displayKey,
    ).toBe('SetBoard')
  })

  it('lists only TypeSlot fields', async () => {
    const slots = await fetchTypeSlots(chain() as never, OU)
    expect(slots).toHaveLength(2)
  })

  it('reads head-current membership from the roster table', async () => {
    const gov = await fetchDaoGovernance(chain() as never, OU)
    const sui = chain() as never
    expect(
      await fetchIsBoardMember(sui, gov.state!.membersTableId, ALICE),
    ).toBe(true)
    expect(
      await fetchIsBoardMember(sui, gov.state!.membersTableId, hex('99')),
    ).toBe(false)
  })
})

describe('singleVoteExecutable', () => {
  it('turns on quorum × board size', () => {
    expect(singleVoteExecutable(5, baseConfig({ quorum: 5000 }))).toBe(false)
    expect(singleVoteExecutable(5, baseConfig({ quorum: 1 }))).toBe(true)
    expect(singleVoteExecutable(2, baseConfig({ quorum: 5000 }))).toBe(true)
  })

  it('refuses a delay, an empty board, or a propose threshold above one vote', () => {
    expect(singleVoteExecutable(1, baseConfig({ executionDelayMs: 1 }))).toBe(
      false,
    )
    expect(singleVoteExecutable(0, baseConfig())).toBe(false)
    expect(singleVoteExecutable(1, baseConfig({ proposeThreshold: 2 }))).toBe(
      false,
    )
  })
})

describe('permission floors', () => {
  it('80% for any high-impact bit, none otherwise', () => {
    expect(permissionFloor(PERMISSIONS.TREASURY_WITHDRAW)).toBe(8000)
    expect(permissionFloor(PERMISSIONS.VAULT_BORROW)).toBe(8000)
    expect(permissionFloor(PERMISSIONS.BOARD_ADD | PERMISSIONS.FREEZE)).toBe(0)
  })
})
