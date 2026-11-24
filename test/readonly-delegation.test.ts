/**
 * `ReadOnlyClient` — the client the MCP read tools call — passes each read to
 * the indexer with its arguments intact, and turns "no market here" into a
 * typed `PoolNotFound` rather than a null the caller must remember to check.
 */
import { jest } from '@jest/globals'
import { TriexError } from '../src/errors'
import { ReadOnlyClient } from '../src/ReadOnlyClient'

const HEX = `0x${'7f'.repeat(32)}`

function client() {
  const ro = new ReadOnlyClient({ apiKey: 'k' })
  const stub = (name: string, value: unknown = {}) => {
    const fn = jest.fn(async () => value)
    ;(ro.indexer as any)[name] = fn
    return fn
  }
  return { ro, stub }
}

describe('ReadOnlyClient delegation', () => {
  it.each([
    ['discover', 'discovery', [{ assetId: '1' }]],
    ['itemsAtHub', 'hubItems', [HEX]],
    ['poolMetadata', 'poolMetadata', [HEX]],
    ['hubLocations', 'hubLocations', [{ limit: 5 }]],
    ['nearbyHubs', 'nearbyHubs', [{ hubId: HEX }]],
    ['nearbyHubsBySystem', 'nearbyHubsBySystem', [{ solarSystem: 'X' }]],
    ['hubsEnriched', 'hubsEnriched', [{ hubIds: [HEX] }]],
    ['assemblyOwners', 'assemblyOwners', [{ assemblyIds: [HEX] }]],
    ['spatialSystem', 'solarSystem', ['EHK-KH7']],
    ['spatialStats', 'spatialStats', []],
    ['fills', 'fills', [HEX, { limit: 3 }]],
    ['sweepable', 'sweepable', [HEX, { minCheckpoint: 5n }]],
    ['stats', 'stats', []],
    ['recipes', 'recipes', []],
    ['routingStats', 'routingStats', []],
  ] as Array<[string, string, unknown[]]>)(
    '%s → indexer.%s',
    async (method, indexerMethod, args) => {
      const { ro, stub } = client()
      const fn = stub(indexerMethod)
      await (ro as any)[method](...args)
      expect(fn).toHaveBeenCalledTimes(1)
      // Every value the caller gave reaches the indexer, however wrapped.
      const sent = JSON.stringify(fn.mock.calls[0], (_k, v) =>
        typeof v === 'bigint' ? String(v) : v,
      )
      const leaves = (v: unknown): unknown[] =>
        Array.isArray(v)
          ? v.flatMap(leaves)
          : v && typeof v === 'object'
            ? Object.values(v).flatMap(leaves)
            : [v]
      for (const leaf of leaves(args)) {
        expect(sent).toContain(String(leaf))
      }
    },
  )

  it('hub() joins the vault and the location', async () => {
    const { ro, stub } = client()
    stub('hubVault', { hubId: HEX, collectionId: 'C', vaultConfigId: 'V' })
    stub('hubLocation', null)
    expect(await ro.hub(HEX)).toEqual({
      hubId: HEX,
      collectionId: 'C',
      vaultConfigId: 'V',
      location: null,
    })
  })

  it('resolvePool() goes hub → collection → pool, and types a missing market', async () => {
    const { ro, stub } = client()
    stub('hubVault', { collectionId: 'C' })
    const resolve = stub('resolvePool', HEX)
    expect(await ro.resolvePool({ storageUnitId: HEX, assetId: '7' })).toBe(HEX)
    expect(resolve).toHaveBeenCalledWith({ collectionId: 'C', assetId: '7' })

    stub('resolvePool', null)
    await expect(
      ro.resolvePool({ storageUnitId: HEX, assetId: '7' }),
    ).rejects.toMatchObject({ code: TriexError.PoolNotFound })
  })

  it('orderbook() types a hub that trades but has no market for the item', async () => {
    const { ro, stub } = client()
    stub('hubItemOrderbook', { poolId: null, bids: [], asks: [] })
    await expect(
      ro.orderbook({ storageUnitId: HEX, assetId: '7' }),
    ).rejects.toMatchObject({ code: TriexError.PoolNotFound })
  })
})
