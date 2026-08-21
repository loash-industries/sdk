import {
  executeAndNormalize,
  normalizeExecuteResult,
  findCreatedObject,
} from '../src/execute'
import { TriexClientError, TriexError } from '../src/errors'

const BM_TYPE = '0xabc::balance_manager::BalanceManager'

describe('normalizeExecuteResult', () => {
  it('normalizes a v2 TransactionResult with effects + objectTypes', () => {
    const res = normalizeExecuteResult({
      $kind: 'Transaction',
      Transaction: {
        digest: '0xd',
        status: { success: true, error: null },
        effects: {
          changedObjects: [
            { objectId: '0x1', idOperation: 'Created' },
            { objectId: '0x2', idOperation: 'None' },
          ],
        },
        objectTypes: { '0x1': BM_TYPE, '0x2': '0x2::coin::Coin' },
      },
    })
    expect(res.digest).toBe('0xd')
    expect(res.createdObjects).toEqual([
      { objectId: '0x1', objectType: BM_TYPE },
    ])
    expect(findCreatedObject(res, '::balance_manager::BalanceManager')).toEqual(
      {
        objectId: '0x1',
        objectType: BM_TYPE,
      },
    )
  })

  it('falls back to the objectTypes map when effects are not included', () => {
    const res = normalizeExecuteResult({
      $kind: 'Transaction',
      Transaction: {
        digest: '0xd',
        status: { success: true, error: null },
        objectTypes: { '0x9': BM_TYPE },
      },
    })
    expect(findCreatedObject(res, 'BalanceManager')?.objectId).toBe('0x9')
  })

  it('throws typed TransactionFailed for a v2 FailedTransaction, with abort translation', () => {
    try {
      normalizeExecuteResult({
        $kind: 'FailedTransaction',
        FailedTransaction: {
          digest: '0xdead',
          status: {
            success: false,
            error: {
              message:
                'MoveAbort(MoveLocation { module: ModuleId { address: 0x291b, name: Identifier("balance_manager") }, function: 12, instruction: 38, function_name: Some("withdraw") }, 3)',
            },
          },
        },
      })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(TriexClientError)
      expect((e as TriexClientError).code).toBe(TriexError.TransactionFailed)
      expect((e as TriexClientError).message).toContain('insufficient currency')
      expect((e as TriexClientError).message).toContain('0xdead')
    }
  })

  it('normalizes the legacy {digest, objectChanges} shape', () => {
    const res = normalizeExecuteResult({
      digest: '0xd',
      objectChanges: [
        { type: 'created', objectId: '0x1', objectType: BM_TYPE },
        { type: 'mutated', objectId: '0x2', objectType: 'x' },
      ],
    })
    expect(res.createdObjects).toEqual([
      { objectId: '0x1', objectType: BM_TYPE },
    ])
  })

  it('throws typed TransactionFailed for legacy effects failure', () => {
    expect(() =>
      normalizeExecuteResult({
        digest: '0xd',
        effects: { status: { status: 'failure', error: 'MoveAbort … blah' } },
      }),
    ).toThrow(TriexClientError)
  })

  it('rejects unrecognized executor results', () => {
    try {
      normalizeExecuteResult({ nope: true })
      throw new Error('expected throw')
    } catch (e) {
      expect((e as TriexClientError).code).toBe(TriexError.UnexpectedResponse)
    }
  })
})

describe('executeAndNormalize', () => {
  it('wraps thrown pre-submit Move aborts as typed TransactionFailed (live format)', async () => {
    const executor = async () => {
      // Exact format the v2 client throws during transaction resolution.
      throw new Error(
        "Transaction resolution failed: MoveAbort in 2nd command, abort code: 8, in '0x291b9da738dffedd18d7c5049e5e6792270202e03f3c9d9db4c7097670bf6eb2::book::cancel_order' (instruction 102)",
      )
    }
    try {
      await executeAndNormalize(executor, {})
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(TriexClientError)
      expect((e as TriexClientError).code).toBe(TriexError.TransactionFailed)
      expect((e as TriexClientError).message).toContain('Order not found')
    }
  })

  it('passes non-abort executor throws through untouched', async () => {
    const boom = new Error('network unreachable')
    const executor = async () => {
      throw boom
    }
    await expect(executeAndNormalize(executor, {})).rejects.toBe(boom)
  })

  it('normalizes successful results end to end', async () => {
    const executor = async () => ({ digest: '0xd', objectChanges: [] })
    const res = await executeAndNormalize(executor, {})
    expect(res.digest).toBe('0xd')
  })
})
