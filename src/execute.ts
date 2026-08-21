import { TriexClientError, TriexError, explainMoveAbort } from './errors'

/**
 * Executor-result normalization. Executors differ by wallet/client generation:
 *
 * - v2 core clients (`SuiGrpcClient.signAndExecuteTransaction`) resolve with
 *   `{ $kind: 'Transaction' | 'FailedTransaction', Transaction: { digest,
 *   status, effects?, objectTypes?, … } }`
 * - Legacy JSON-RPC / dapp-kit flows resolve with
 *   `{ digest, objectChanges?: […], effects?, … }`
 *
 * The SDK accepts either, extracts what it needs (digest + created objects),
 * and turns an on-chain execution failure into a typed `TransactionFailed`
 * error that includes the translated Move abort when recognizable.
 */

export interface CreatedObject {
  objectId: string
  objectType: string
}

export interface NormalizedExecution {
  digest: string
  /** Objects created by the transaction, when the executor surfaced them. */
  createdObjects: CreatedObject[]
  /** The executor's untouched return value. */
  raw: unknown
}

export function normalizeExecuteResult(raw: unknown): NormalizedExecution {
  const r = raw as any

  // v2 core-client TransactionResult (Transaction | FailedTransaction).
  const node = r?.Transaction ?? r?.FailedTransaction
  if (node && typeof node.digest === 'string') {
    const failed =
      r?.$kind === 'FailedTransaction' ||
      r?.FailedTransaction !== undefined ||
      node.status?.success === false
    if (failed) {
      const errorText = JSON.stringify(node.status?.error ?? 'unknown error')
      const explained = explainMoveAbort(errorText)
      throw new TriexClientError(
        TriexError.TransactionFailed,
        `Transaction ${node.digest} failed on-chain${explained ? `: ${explained}` : ''} (${errorText}).`,
        node.status?.error,
      )
    }
    const createdObjects: CreatedObject[] = []
    const objectTypes: Record<string, string> = node.objectTypes ?? {}
    const changed: any[] = node.effects?.changedObjects ?? []
    if (changed.length > 0) {
      for (const ch of changed) {
        if (ch?.idOperation === 'Created' && typeof ch.objectId === 'string') {
          createdObjects.push({
            objectId: ch.objectId,
            objectType: objectTypes[ch.objectId] ?? '',
          })
        }
      }
    } else {
      // No effects included — fall back to the objectTypes map (all changed
      // objects); fine for created-object *lookup* by type.
      for (const [objectId, objectType] of Object.entries(objectTypes)) {
        createdObjects.push({ objectId, objectType })
      }
    }
    return { digest: node.digest, createdObjects, raw }
  }

  // Legacy shape: digest at the top level, optional objectChanges.
  if (typeof r?.digest === 'string') {
    const createdObjects: CreatedObject[] = []
    for (const ch of r.objectChanges ?? []) {
      if (
        ch?.type === 'created' &&
        typeof ch.objectId === 'string' &&
        typeof ch.objectType === 'string'
      ) {
        createdObjects.push({ objectId: ch.objectId, objectType: ch.objectType })
      }
    }
    // Legacy effects-level failure (JSON-RPC): status.status === 'failure'.
    const legacyStatus = r.effects?.status
    if (legacyStatus?.status === 'failure') {
      const errorText = String(legacyStatus.error ?? 'unknown error')
      const explained = explainMoveAbort(errorText)
      throw new TriexClientError(
        TriexError.TransactionFailed,
        `Transaction ${r.digest} failed on-chain${explained ? `: ${explained}` : ''} (${errorText}).`,
        legacyStatus.error,
      )
    }
    return { digest: r.digest, createdObjects, raw }
  }

  throw new TriexClientError(
    TriexError.UnexpectedResponse,
    'Executor returned an unrecognized result — expected a v2 TransactionResult or an object with a `digest`.',
  )
}

/** First created object whose type contains `typeSubstring`, if any. */
export function findCreatedObject(
  result: NormalizedExecution,
  typeSubstring: string,
): CreatedObject | undefined {
  return result.createdObjects.find((o) => o.objectType.includes(typeSubstring))
}
