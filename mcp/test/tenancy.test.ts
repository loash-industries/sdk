import { jest } from '@jest/globals'
import type { Server } from 'node:http'
import { createApp, extractApiKey } from '../src/http.js'
import { createContext } from '../src/context.js'
import { loadConfig } from '../src/env.js'
import { log, redact, tenantLabel } from '../src/logging.js'
import { toJsonText } from '../src/result.js'

const KEY_A = 'tenant-a-secret-key'
const KEY_B = 'tenant-b-secret-key'
const ADDR_A = '0x'.padEnd(66, 'a')
const ADDR_B = '0x'.padEnd(66, 'b')

const config = loadConfig({
  TRIEX_MCP_MODE: 'prepare',
  MAX_CONCURRENCY_PER_KEY: '2',
} as NodeJS.ProcessEnv)

describe('credential extraction', () => {
  const req = (headers: Record<string, string>) =>
    ({ header: (n: string) => headers[n.toLowerCase()] }) as any

  it('reads the x-api-key header', () => {
    expect(extractApiKey(req({ 'x-api-key': KEY_A }))).toBe(KEY_A)
  })

  it('accepts a bearer token as an alternative', () => {
    expect(extractApiKey(req({ authorization: `Bearer ${KEY_A}` }))).toBe(KEY_A)
  })

  it('returns null when no credential is present', () => {
    expect(extractApiKey(req({}))).toBeNull()
  })

  it('treats a blank credential as absent', () => {
    expect(extractApiKey(req({ 'x-api-key': '   ' }))).toBeNull()
  })
})

describe('tenant isolation', () => {
  it('builds a distinct client per request, with no shared credential state', () => {
    const a = createContext(KEY_A, config, {} as any)
    const b = createContext(KEY_B, config, {} as any)

    expect(a.apiKey).toBe(KEY_A)
    expect(b.apiKey).toBe(KEY_B)
    expect(a.readClient()).not.toBe(b.readClient())
    // Even the same tenant gets a fresh client per call — nothing is pooled by
    // credential, so there is no cache for one tenant to read another out of.
    expect(a.readClient()).not.toBe(a.readClient())
    expect(a.writeClient(ADDR_A)).not.toBe(b.writeClient(ADDR_B))
  })

  it('shares only the credential-free Sui client', () => {
    const sui = {} as any
    const a = createContext(KEY_A, config, sui)
    const b = createContext(KEY_B, config, sui)
    expect(a.suiClient()).toBe(b.suiClient())
  })

  it('never serializes the API key into a tool result', () => {
    const ctx = createContext(KEY_A, config, {} as any)
    const rendered = toJsonText({ balances: [], context: { ok: true } })
    expect(rendered).not.toContain(ctx.apiKey)
  })
})

describe('credential redaction', () => {
  it('redacts credential-bearing header names', () => {
    const out = redact({
      'x-api-key': KEY_A,
      authorization: `Bearer ${KEY_A}`,
      cookie: 'session=1',
      tenant: 'abc123',
    })
    expect(out['x-api-key']).toBe('[redacted]')
    expect(out['authorization']).toBe('[redacted]')
    expect(out['cookie']).toBe('[redacted]')
    expect(out['tenant']).toBe('abc123')
  })

  it('keeps the API key out of emitted log lines', () => {
    const lines: string[] = []
    const spy = jest.spyOn(console, 'log').mockImplementation((l) => {
      lines.push(String(l))
    })
    log('info', 'request', { 'x-api-key': KEY_A, tenant: tenantLabel(KEY_A) })
    spy.mockRestore()
    expect(lines.join('\n')).not.toContain(KEY_A)
    expect(lines.join('\n')).toContain('[redacted]')
  })

  it('labels tenants stably without exposing the key', () => {
    expect(tenantLabel(KEY_A)).toBe(tenantLabel(KEY_A))
    expect(tenantLabel(KEY_A)).not.toBe(tenantLabel(KEY_B))
    expect(tenantLabel(KEY_A)).not.toContain(KEY_A)
    expect(tenantLabel(KEY_A)).toHaveLength(12)
  })
})

describe('http surface', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createApp(config).listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('serves health without a credential', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('ok')
  })

  it('reports mode and network on readyz', async () => {
    const body = (await (await fetch(`${base}/readyz`)).json()) as {
      mode: string
      network: string
    }
    expect(body.mode).toBe('prepare')
    expect(body.network).toBe('testnet')
  })

  it('rejects an uncredentialed MCP call before any upstream work', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/x-api-key/)
  })

  it('refuses GET and DELETE — the server is stateless', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method })
      expect(res.status).toBe(405)
    }
  })

  it('lists tools for a credentialed caller', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-api-key': KEY_A,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('prepare_limit_order')
    expect(text).toContain('market_orderbook')
    // The caller's own key must never be echoed back.
    expect(text).not.toContain(KEY_A)
  })
})
