#!/usr/bin/env node
// Refresh the locally-installed @trinaryex/sdk from the sibling build.
//
//   npm run link:sdk
//
// The MCP package depends on a PUBLISHED @trinaryex/sdk, so a surface added in
// the sibling checkout is invisible here until it ships. That is fine for CI
// and wrong for development: the parity gate would report "lock-step" against a
// version that predates the work being done, which is the exact failure the
// gate exists to prevent. Copying the built dist in makes local checks tell the
// truth. `npm install` overwrites it again, which is the correct default.
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', '..')
const target = join(here, '..', 'node_modules', '@trinaryex', 'sdk')

const sourceDist = join(source, 'dist')
if (!existsSync(sourceDist)) {
  console.error(
    `No build at ${sourceDist} — run \`npm run build\` in the SDK first.`,
  )
  process.exit(2)
}
if (!existsSync(target)) {
  console.error(`@trinaryex/sdk is not installed at ${target} — run \`npm install\`.`)
  process.exit(2)
}

cpSync(sourceDist, join(target, 'dist'), { recursive: true })
cpSync(join(source, 'package.json'), join(target, 'package.json'))

const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
console.log(
  `Linked local @trinaryex/sdk@${version} into mcp/node_modules.\n` +
    'Run `npm install` to restore the published copy.',
)
