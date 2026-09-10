import { Transaction } from '@mysten/sui/transactions'
import {
  NothingToPrepare,
  TransactionCaptured,
  captureExecutor,
  captureTransaction,
} from '../src/capture.js'
import { executeAndNormalize } from '@trinaryex/sdk'

describe('capture executor', () => {
  it('captures the transaction instead of executing it', async () => {
    const tx = new Transaction()
    const captured = await captureTransaction(async () => captureExecutor(tx))
    expect(captured).toBe(tx)
  })

  it('throws NothingToPrepare when no transaction was built', async () => {
    await expect(
      captureTransaction(async () => ({
        balanceManagerId: '0x1',
        created: false,
      })),
    ).rejects.toBeInstanceOf(NothingToPrepare)
  })

  it('carries the SDK result on NothingToPrepare so callers can explain it', async () => {
    const result = { balanceManagerId: '0xabc', created: false }
    await captureTransaction(async () => result).catch((e) => {
      expect(e).toBeInstanceOf(NothingToPrepare)
      expect((e as NothingToPrepare).result).toBe(result)
    })
  })

  it('propagates real SDK errors untouched', async () => {
    const boom = new Error('hub not found')
    await expect(
      captureTransaction(async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
  })

  /**
   * The signal must survive the SDK's own error handling: `executeAndNormalize`
   * wraps `TriexClientError` and anything Move-abort-shaped, and rethrows
   * everything else untouched. If this ever regresses, every prepare tool
   * silently turns into a failed transaction report.
   */
  it('survives the SDK executeAndNormalize error path unwrapped', async () => {
    const tx = new Transaction()
    await expect(
      executeAndNormalize(captureExecutor, tx),
    ).rejects.toBeInstanceOf(TransactionCaptured)
  })

  it('does not use an abort-shaped message', () => {
    const message = new TransactionCaptured(new Transaction()).message
    expect(message).not.toMatch(/MoveAbort|abort code/i)
  })
})
