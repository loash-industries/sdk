import {
  diffGateway,
  loadSpec,
  normalizePath,
  readGatewaySurface,
  readSdkCalls,
} from '../scripts/gateway-surface.mjs'
import type { GatewayOperation, SdkCall } from '../scripts/gateway-surface.mjs'

/**
 * Lock-step with the upstream gateway.
 *
 * The SDK's own contract is checked against `@trinaryex/sdk`'s consumers by the
 * MCP package's parity gate. This is the layer below: the requests this SDK
 * issues, checked against the gateway's PUBLISHED OpenAPI document.
 *
 * Two kinds of drift, and only one of them announces itself. A moved endpoint
 * 404s in the first integration run. A renamed query parameter does not — the
 * gateway ignores keys it does not recognise rather than rejecting them, so
 * the request still returns 200 with a full body and every layer above
 * believes it asked a narrower question than it did. A filter that stopped
 * filtering looks exactly like a filter that matched everything.
 *
 * Runs against a vendored copy of the contract so it needs no network and no
 * API key. `npm run check:gateway -- --live` checks the same thing against
 * api.trinary.exchange, and `npm run refresh:gateway` updates the fixture.
 */
const spec = loadSpec()
const surface = readGatewaySurface(spec)
const calls = readSdkCalls()
const diff = diffGateway(surface, calls)

describe('gateway contract', () => {
  it('parses a plausible surface from the vendored document', () => {
    expect(spec.openapi).toMatch(/^3\./)
    expect(surface.length).toBeGreaterThanOrEqual(30)
    expect(surface.every((o) => o.path.startsWith('/'))).toBe(true)
    expect(surface.every((o) => o.method === o.method.toUpperCase())).toBe(true)
  })

  it('reads query parameters and their requiredness', () => {
    const discovery = surface.find(
      (o) => o.path === '/v1/discovery' && o.method === 'GET',
    )
    expect(discovery).toBeDefined()
    expect(discovery!.query.map((p) => p.name)).toEqual(
      expect.arrayContaining(['asset_id', 'limit']),
    )
  })

  it('normalizes both path dialects to one shape', () => {
    expect(normalizePath('/v1/hubs/{hub_id}/items')).toBe('/v1/hubs/{}/items')
    expect(normalizePath('/v1/hubs/${encodeURIComponent(hubId)}/items')).toBe(
      '/v1/hubs/{}/items',
    )
    // Arity is meaningful even though parameter names are not.
    expect(normalizePath('/v1/hubs/{a}/items/{b}/orderbook')).not.toBe(
      normalizePath('/v1/hubs/{a}/items'),
    )
  })
})

describe('SDK requests', () => {
  it('finds the request layer', () => {
    expect(calls.length).toBeGreaterThanOrEqual(10)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('reads every call site statically', () => {
    // A call whose path or query is assembled dynamically cannot be checked
    // against the contract at all, so it is a gap in coverage, not a pass.
    expect(diff.unverifiable.map((c) => `${c.file}:${c.line}`)).toEqual([])
  })
})

describe('lock-step with the gateway', () => {
  it('calls only endpoints the gateway publishes', () => {
    expect(
      diff.unknownEndpoints.map(
        (u) => `${u.method} ${u.path} (${u.file}:${u.line})`,
      ),
    ).toEqual([])
  })

  it('sends only query parameters the endpoint declares', () => {
    expect(
      diff.unknownParams.map(
        (u) =>
          `${u.param} → ${u.method} ${u.path} (declares: ${u.declared.join(', ')})`,
      ),
    ).toEqual([])
  })

  it('sends every required query parameter', () => {
    expect(
      diff.missingRequired.map((m) => `${m.param} → ${m.method} ${m.path}`),
    ).toEqual([])
  })

  it('accounts for every call site exactly once', () => {
    expect(diff.matched.length + diff.unverifiable.length).toBe(calls.length)
  })
})

/**
 * A gate that cannot fail is not a gate. These drive `diffGateway` with
 * doctored inputs to prove each failure mode is actually detected.
 */
describe('the gateway gate detects drift', () => {
  const fakeSurface: GatewayOperation[] = [
    {
      path: '/v1/discovery',
      normalized: '/v1/discovery',
      method: 'GET',
      operationId: 'discovery',
      query: [
        { name: 'asset_id', required: false },
        { name: 'storage_unit_ids', required: false },
        { name: 'limit', required: false },
      ],
      pathParams: [],
    },
    {
      path: '/v1/hubs/{hub_id}/items',
      normalized: '/v1/hubs/{}/items',
      method: 'GET',
      operationId: 'hubItems',
      query: [{ name: 'cursor', required: true }],
      pathParams: ['hub_id'],
    },
  ]

  const call = (over: Partial<SdkCall>): SdkCall => ({
    path: '/v1/discovery',
    normalized: '/v1/discovery',
    method: 'GET',
    query: [],
    dynamic: false,
    file: 'src/queries.ts',
    line: 1,
    ...over,
  })

  it('flags an endpoint the gateway does not publish', () => {
    const result = diffGateway(fakeSurface, [
      call({ path: '/v1/discover', normalized: '/v1/discover' }),
    ])
    expect(result.unknownEndpoints.map((u) => u.path)).toEqual(['/v1/discover'])
  })

  it('suggests near misses for a renamed endpoint', () => {
    const result = diffGateway(fakeSurface, [
      call({
        path: '/v1/hubs/${}/inventory',
        normalized: '/v1/hubs/{}/inventory',
      }),
    ])
    expect(result.unknownEndpoints[0]?.candidates).toContain(
      'GET /v1/hubs/{hub_id}/items',
    )
  })

  it('flags a path whose arity changed', () => {
    const result = diffGateway(fakeSurface, [
      call({
        path: '/v1/hubs/${}/items/${}',
        normalized: '/v1/hubs/{}/items/{}',
      }),
    ])
    expect(result.unknownEndpoints).toHaveLength(1)
  })

  it('flags the silent failure: a query parameter the endpoint ignores', () => {
    const result = diffGateway(fakeSurface, [call({ query: ['hub_id'] })])
    expect(result.unknownParams).toHaveLength(1)
    expect(result.unknownParams[0]).toMatchObject({ param: 'hub_id' })
    expect(result.unknownParams[0]?.declared).toContain('storage_unit_ids')
  })

  it('flags a renamed parameter even though the endpoint still resolves', () => {
    // The shape of a real regression: right URL, wrong filter key, HTTP 200.
    const result = diffGateway(fakeSurface, [
      call({ query: ['storage_unit_id'] }), // singular
    ])
    expect(result.unknownParams.map((u) => u.param)).toEqual([
      'storage_unit_id',
    ])
  })

  it('accepts parameters the endpoint declares', () => {
    const result = diffGateway(fakeSurface, [
      call({ query: ['asset_id', 'limit', 'storage_unit_ids'] }),
    ])
    expect(result.unknownParams).toEqual([])
    expect(result.matched).toHaveLength(1)
  })

  it('flags a required parameter the SDK never sends', () => {
    const result = diffGateway(fakeSurface, [
      call({
        path: '/v1/hubs/${}/items',
        normalized: '/v1/hubs/{}/items',
        query: [],
      }),
    ])
    expect(result.missingRequired.map((m) => m.param)).toEqual(['cursor'])
  })

  it('honours an explicit allowance for a parameter outside the document', () => {
    const result = diffGateway(fakeSurface, [call({ query: ['trace_id'] })], {
      allowedExtraParams: ['trace_id'],
    })
    expect(result.unknownParams).toEqual([])
  })

  it('reports a dynamic call site rather than passing it', () => {
    const result = diffGateway(fakeSurface, [call({ dynamic: true })])
    expect(result.unverifiable).toHaveLength(1)
    expect(result.matched).toEqual([])
  })

  it('lists published operations the SDK does not wrap, without failing', () => {
    const result = diffGateway(fakeSurface, [call({ query: [] })])
    expect(result.unusedEndpoints.map((o) => o.path)).toEqual([
      '/v1/hubs/{hub_id}/items',
    ])
  })
})
