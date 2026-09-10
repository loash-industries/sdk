#!/usr/bin/env node
// Fails when the MCP tool surface has drifted from the SDK it wraps.
//
// Run with `npm run check:parity`. The same checks run in the test suite, so
// CI enforces them on every PR; this script exists to give a readable report
// while developing, and to be callable from other tooling.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffSurface, readSdkSurface } from './sdk-surface.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const registryPath = join(here, '..', 'dist', 'registry.js')

if (!existsSync(registryPath)) {
  console.error('dist/registry.js is missing — run `npm run build` first.')
  process.exit(2)
}

const { ALL_TOOLS, EXCLUDED_SDK_PATHS } = await import(registryPath)
const surface = readSdkSurface()
const diff = diffSurface(surface, ALL_TOOLS, EXCLUDED_SDK_PATHS)

const counts = {
  sdkMethods: surface.length,
  writes: surface.filter((m) => m.kind === 'write').length,
  reads: surface.filter((m) => m.kind === 'read').length,
  tools: ALL_TOOLS.length,
  excluded: Object.keys(EXCLUDED_SDK_PATHS).length,
}

console.log(
  `SDK surface: ${counts.sdkMethods} methods (${counts.reads} read, ${counts.writes} write)\n` +
    `MCP tools:   ${counts.tools}  ·  explicitly excluded: ${counts.excluded}\n`,
)

console.log(
  surface
    .map((m) => {
      const tool =
        diff.covered.find((c) => c.path === m.path)?.tool ??
        (EXCLUDED_SDK_PATHS[m.path] ? '(excluded)' : undefined)
      const mark = tool ? (tool === '(excluded)' ? '–' : '✓') : '✗'
      return `  ${mark} ${m.kind.padEnd(5)} ${m.path.padEnd(26)} ${tool ?? 'NO TOOL'}`
    })
    .join('\n'),
)

const problems = []

if (diff.missing.length) {
  problems.push(
    'SDK methods with no tool and no exclusion:\n' +
      diff.missing
        .map(
          (m) =>
            `  ${m.path} (${m.kind}) — add a ${m.kind === 'write' ? 'prepare_*' : 'read'} tool, or an EXCLUDED_SDK_PATHS entry explaining why not`,
        )
        .join('\n'),
  )
}

if (diff.miscovered.length) {
  problems.push(
    'Tools of the wrong kind:\n' +
      diff.miscovered
        .map(
          (m) =>
            `  ${m.path} returns ${m.returns} so it is a ${m.kind}; expected a ${m.expected} tool but ${m.tool} is a ${m.actual} tool`,
        )
        .join('\n'),
  )
}

if (diff.dangling.length) {
  problems.push(
    'Tools pointing at SDK methods that no longer exist:\n' +
      diff.dangling.map((p) => `  ${p}`).join('\n'),
  )
}

if (diff.staleExclusions.length) {
  problems.push(
    'Exclusions for SDK methods that no longer exist:\n' +
      diff.staleExclusions.map((p) => `  ${p}`).join('\n'),
  )
}

if (problems.length) {
  console.error('\n' + problems.join('\n\n'))
  console.error('\nMCP is OUT OF LOCK-STEP with the SDK.')
  process.exit(1)
}

console.log('\nMCP covers the SDK surface in lock-step.')
