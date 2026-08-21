import { normalizeExecuteResult, findCreatedObject } from '../src/execute'
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
    expect(res.createdObjects).toEqual([{ objectId: '0x1', objectType: BM_TYPE }])
    expect(findCreatedObject(res, '::balance_manager::BalanceManager')).toEqual({
      objectId: '0x1',
      objectType: BM_TYPE,
    })
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
    expect(res.createdObjects).toEqual([{ objectId: '0x1', objectType: BM_TYPE }])
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
