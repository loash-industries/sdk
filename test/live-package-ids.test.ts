/**
 * Live package ids: a routine upgrade moves the client's moveCall targets
 * without an SDK release, and nothing else ever moves.
 */
import { jest } from '@jest/globals'
import { STILLNESS_PACKAGE_IDS, resolvePackageIds } from '../src/config'
import { TriexError } from '../src/errors'
import { applyLivePackageIds, fetchLivePackageIds } from '../src/livePackageIds'
import { TriexClient } from '../src/TriexClient'

const NEW_TRIEX = '0x' + '9e'.repeat(32)
const OTHER = '0x' + '77'.repeat(32)

function serve(body: unknown, ok = true): jest.Mock {
  const fn = jest.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }))
  ;(global as any).fetch = fn
  return fn
}

afterEach(() => jest.restoreAllMocks())

const wire = (over: Record<string, string> = {}) => ({
  triexPackageId: NEW_TRIEX,
  triexPackageIdOriginal: STILLNESS_PACKAGE_IDS.triexOriginal,
  armatureTradingPackageId: STILLNESS_PACKAGE_IDS.armatureTrading,
  armatureTradingPackageIdOriginal:
    STILLNESS_PACKAGE_IDS.armatureTradingOriginal,
  // A cycle rollover for world: different original.
  worldPackageId: OTHER,
  worldOriginalPackageId: OTHER,
  glyphRegistryPackageId: OTHER, // not a field the SDK knows: ignored
  ...over,
})

describe('applying live package ids', () => {
  it('moves an upgraded target, skips another lineage, leaves the rest', async () => {
    serve(wire())
    const ids = resolvePackageIds('testnet')
    const before = { ...ids }
    const report = applyLivePackageIds(ids, await fetchLivePackageIds())

    expect(ids.triex).toBe(NEW_TRIEX)
    // Original ids, shared objects and type-tag ids never move.
    expect(ids.triexOriginal).toBe(before.triexOriginal)
    expect(ids.triexRegistry).toBe(before.triexRegistry)
    expect(ids.world).toBe(before.world)
    expect(report.applied).toEqual([
      { field: 'triex', from: before.triex, to: NEW_TRIEX },
    ])
    expect(report.skipped).toEqual([
      expect.objectContaining({ field: 'world' }),
    ])
  })

  it('never moves a field the caller pinned', async () => {
    serve(wire())
    const ids = resolvePackageIds('testnet', { triex: OTHER })
    const report = applyLivePackageIds(
      ids,
      await fetchLivePackageIds(),
      new Set(['triex']),
    )
    expect(ids.triex).toBe(OTHER)
    expect(report.skipped).toContainEqual({
      field: 'triex',
      reason: 'pinned by an override',
    })
  })

  it('asks for the tenant and ignores malformed ids', async () => {
    const fetchMock = serve(wire({ triexPackageId: 'not-an-id' }))
    const live = await fetchLivePackageIds({ tenant: 'utopia' })
    expect((fetchMock.mock.calls[0][0] as URL).searchParams.get('tenant')).toBe(
      'utopia',
    )
    expect(live.find((p) => p.field === 'triex')).toBeUndefined()
  })

  it('fails typed when the endpoint is down', async () => {
    serve({}, false)
    await expect(fetchLivePackageIds()).rejects.toMatchObject({
      code: TriexError.IndexerError,
    })
  })
})

describe('client.refreshPackageIds / TriexClient.connect', () => {
  const config = { apiKey: 'k', suiClient: {} as any }

  it('updates the ids every sub-API reads', async () => {
    serve(wire())
    const client = new TriexClient(config)
    await client.refreshPackageIds()
    expect(client.ids.triex).toBe(NEW_TRIEX)
    expect(client.lastPackageIdRefresh?.applied).toHaveLength(1)
    // The preset itself is untouched.
    expect(STILLNESS_PACKAGE_IDS.triex).not.toBe(NEW_TRIEX)
  })

  it('connect keeps the baked ids when the fetch fails', async () => {
    serve({}, false)
    const client = await TriexClient.connect(config)
    expect(client.ids.triex).toBe(STILLNESS_PACKAGE_IDS.triex)
    expect(client.lastPackageIdRefresh).toBeNull()
  })

  it('connect respects packageIds overrides', async () => {
    serve(wire())
    const client = await TriexClient.connect({
      ...config,
      packageIds: { triex: OTHER },
    })
    expect(client.ids.triex).toBe(OTHER)
  })
})
