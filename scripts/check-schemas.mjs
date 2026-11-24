#!/usr/bin/env node
// Checks the SDK's RESPONSE schemas against a gateway contract.
//
//   npm run check:schemas            # against the vendored contract (hermetic)
//   npm run check:schemas -- --live  # against api.trinary.exchange right now
//
// `check:gateway` covers the other direction: what the SDK sends. Responses
// drift too, and more dangerously: a field going nullable upstream makes every
// read that meets one throw, while the request side stays green. The daily
// drift job runs both against the live document.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchSpec } from './gateway-surface.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const live = process.argv.includes('--live')

const env = { ...process.env }
let dir
if (live) {
  dir = mkdtempSync(join(tmpdir(), 'gateway-spec-'))
  const path = join(dir, 'gateway-openapi.live.json')
  const spec = await fetchSpec()
  writeFileSync(path, JSON.stringify(spec))
  env.GATEWAY_SPEC = path
  console.log(
    `Checking response schemas against the live contract (API version ${spec.info?.version ?? '?'}).`,
  )
}

const result = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    join(root, 'node_modules', '.bin', 'jest'),
    'test/schema-conformance.test.ts',
  ],
  { cwd: root, env, stdio: 'inherit' },
)
if (dir) rmSync(dir, { recursive: true, force: true })

if (result.status !== 0 && live) {
  console.error(
    '\nThe SDK does not parse what the LIVE gateway may send. Refresh the vendored\n' +
      'contract and fix the schemas it flags:\n\n  npm run refresh:gateway && npm test\n',
  )
}
process.exit(result.status ?? 1)
