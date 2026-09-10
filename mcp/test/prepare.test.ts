import { Transaction } from '@mysten/sui/transactions'
import { Inputs } from '@mysten/sui/transactions'
import {
  extractPinnedObjects,
  extractTargets,
  toPrepared,
} from '../src/prepare.js'

const PKG = '0x2'
/** Building normalizes short addresses to full 32-byte form. */
const PKG_NORM = '0x' + '2'.padStart(64, '0')
const OBJ = '0x'.padEnd(66, '7')
const SENDER = '0x'.padEnd(66, 'a')

function txWithCalls(): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${PKG}::balance_manager::generate_proof_as_owner`,
    arguments: [
      tx.object(
        Inputs.ObjectRef({
          objectId: OBJ,
          version: '42',
          digest: '11111111111111111111111111111111',
        }),
      ),
    ],
  })
  tx.moveCall({
    target: `${PKG}::multicoin_pool::place_limit_order`,
    arguments: [tx.pure.u64(1000n)],
  })
  return tx
}

describe('intent extraction', () => {
  it('lists every Move call target in command order', () => {
    expect(extractTargets(txWithCalls())).toEqual([
      `${PKG_NORM}::balance_manager::generate_proof_as_owner`,
      `${PKG_NORM}::multicoin_pool::place_limit_order`,
    ])
  })

  it('reports pinned object inputs with their resolved versions', () => {
    const pinned = extractPinnedObjects(txWithCalls())
    expect(pinned).toEqual([{ objectId: OBJ, version: '42', kind: 'owned' }])
  })

  /**
   * Callers allowlisting `intent.targets` must normalize their expected
   * package ids the same way — a short-form allowlist entry will not match.
   */
  it('normalizes package addresses to full 32-byte form', () => {
    for (const target of extractTargets(txWithCalls())) {
      expect(target.split('::')[0]).toHaveLength(66)
    }
  })

  it('returns no targets for a transaction with no Move calls', () => {
    expect(extractTargets(new Transaction())).toEqual([])
  })
})

describe('prepared contract', () => {
  it('serializes to base64 tx-kind bytes with a derived intent', async () => {
    const prepared = await toPrepared(txWithCalls(), SENDER, undefined as any, {
      action: 'limit_order',
      params: { side: 'buy' },
      worstCaseSpend: { asset: 'CRED', amount: '1000', kind: 'currency' },
    })

    expect(prepared.sender).toBe(SENDER)
    expect(prepared.txKindBytes).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(
      Buffer.from(prepared.txKindBytes, 'base64').byteLength,
    ).toBeGreaterThan(0)
    // Targets come from the built transaction, not from the caller's params —
    // this is what makes the caller's verify-before-sign check meaningful.
    expect(prepared.intent.targets).toEqual([
      `${PKG_NORM}::balance_manager::generate_proof_as_owner`,
      `${PKG_NORM}::multicoin_pool::place_limit_order`,
    ])
    expect(prepared.intent.action).toBe('limit_order')
    expect(prepared.pinnedObjects).toHaveLength(1)
    expect(prepared.builtAtMs).toBeGreaterThan(0)
  })

  it('always ships the verify-before-signing and staleness guidance', async () => {
    const prepared = await toPrepared(txWithCalls(), SENDER, undefined as any, {
      action: 'x',
      params: {},
    })
    expect(prepared.notes.join(' ')).toMatch(/Verify before signing/)
    expect(prepared.notes.join(' ')).toMatch(/pinnedObjects/)
  })

  it('never emits gas data — the sponsor supplies it', async () => {
    const prepared = await toPrepared(txWithCalls(), SENDER, undefined as any, {
      action: 'x',
      params: {},
    })
    // onlyTransactionKind bytes carry no gas payment / owner / budget.
    expect(prepared).not.toHaveProperty('gasData')
  })
})
