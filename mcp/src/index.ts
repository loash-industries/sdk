#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { createApp } from './http.js'
import { loadConfig } from './env.js'
import { log } from './logging.js'
import { toolsForMode } from './registry.js'
import { packageVersion } from './version.js'

function main(): void {
  const config = loadConfig()
  const app = createApp(config)
  const tools = toolsForMode(config.mode).map((t) => t.name)

  const onListening = () =>
    log('info', 'triex-mcp listening', {
      version: packageVersion(),
      mode: config.mode,
      network: config.network,
      host: config.host,
      port: config.port,
      tls: !!config.tls,
      tools: tools.length,
    })

  if (config.tls) {
    createHttpsServer(
      {
        cert: readFileSync(config.tls.certPath),
        key: readFileSync(config.tls.keyPath),
      },
      app,
    ).listen(config.port, config.host, onListening)
  } else {
    app.listen(config.port, config.host, onListening)
  }
}

main()
