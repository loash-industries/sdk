import express from 'express'
import type { Express, Request, Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createContext } from './context.js'
import type { ServerConfig } from './env.js'
import { log, tenantLabel } from './logging.js'
import { createServer } from './server.js'
import { packageVersion } from './version.js'

/** In-flight calls per tenant. Fairness against noisy neighbours, not security. */
const inFlight = new Map<string, number>()

function acquire(label: string, max: number): boolean {
  const current = inFlight.get(label) ?? 0
  if (current >= max) return false
  inFlight.set(label, current + 1)
  return true
}

function release(label: string): void {
  const current = inFlight.get(label) ?? 0
  if (current <= 1) inFlight.delete(label)
  else inFlight.set(label, current - 1)
}

/** Pull the caller's API key out of the request. Never logged, never stored. */
export function extractApiKey(req: Request): string | null {
  const header = req.header('x-api-key')
  if (header && header.trim()) return header.trim()
  const auth = req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim()
    if (token) return token
  }
  return null
}

export function createApp(config: ServerConfig): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: packageVersion() })
  })

  app.get('/readyz', (_req, res) => {
    res.json({
      status: 'ok',
      mode: config.mode,
      network: config.network,
      version: packageVersion(),
    })
  })

  app.post('/mcp', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req)
    if (!apiKey) {
      // Rejected before any upstream call is made.
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Missing credential. Send your Trinary Exchange API key as an x-api-key header.',
        },
        id: null,
      })
      return
    }

    const label = tenantLabel(apiKey)
    if (!acquire(label, config.maxConcurrencyPerKey)) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: {
          code: -32002,
          message: `Too many concurrent requests for this API key (limit ${config.maxConcurrencyPerKey}). Retry shortly.`,
        },
        id: null,
      })
      return
    }

    // Stateless mode: a fresh server and transport per request, so no tenant
    // state can outlive the request or leak into another caller's.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    const server = createServer(createContext(apiKey, config))

    res.on('close', () => {
      release(label)
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      log('error', 'mcp request failed', {
        tenant: label,
        error: e instanceof Error ? e.message : String(e),
      })
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      }
    }
  })

  // Stateless mode has no server-initiated streams and no sessions to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'This server runs stateless; use POST /mcp.',
      },
      id: null,
    })
  }
  app.get('/mcp', methodNotAllowed)
  app.delete('/mcp', methodNotAllowed)

  return app
}
