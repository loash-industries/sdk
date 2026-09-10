#!/usr/bin/env node
// Fails when the MCP tool surface has drifted from the SDK it wraps.
//
// Drift has two shapes and this checks both: a method that gained no tool
// (coverage), and a tool that offers an argument its method does not take
// (arguments). The second is the quieter failure — nothing rejects an unknown
// property, so the tool answers successfully while ignoring what it was asked.
//
// Run with `npm run check:parity`. The same checks run in the test suite, so
// CI enforces them on every PR; this script exists to give a readable report
// while developing, and to be callable from other tooling.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  diffParams,
  diffSurface,
  readKeyspaceSurface,
  readSdkSurface,
} from './sdk-surface.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const registryPath = join(here, '..', 'dist', 'registry.js')

if (!existsSync(registryPath)) {
  console.error('dist/registry.js is missing — run `npm run build` first.')
  process.exit(2)
}

const { ALL_TOOLS, EXCLUDED_SDK_PATHS, GLOBAL_SYNTHETIC_PARAMS } =
  await import(registryPath)
// Both wrapped packages are checked by one gate: the SDK's trading client and
// the keyspace package's read-only lookup client.
const surface = [...readSdkSurface(), ...readKeyspaceSurface()]
const diff = diffSurface(surface, ALL_TOOLS, EXCLUDED_SDK_PATHS)
const params = diffParams(surface, ALL_TOOLS, GLOBAL_SYNTHETIC_PARAMS)

const counts = {
  sdkMethods: surface.length,
  writes: surface.filter((m) => m.kind === 'write').length,
  reads: surface.filter((m) => m.kind === 'read').length,
  tools: ALL_TOOLS.length,
  excluded: Object.keys(EXCLUDED_SDK_PATHS).length,
}

console.log(
  `SDK surface: ${counts.sdkMethods} methods (${counts.reads} read, ${counts.writes} write)\n` +
    `MCP tools:   ${counts.tools}  ·  explicitly excluded: ${counts.excluded}\n` +
    `Parameters:  ${surface.reduce((n, m) => n + m.params.length, 0)} across the surface  ·  ` +
    `waivers: ${Object.keys(GLOBAL_SYNTHETIC_PARAMS).length} global + ` +
    `${ALL_TOOLS.reduce((n, t) => n + Object.keys(t.syntheticParams ?? {}).length + Object.keys(t.derivedParams ?? {}).length, 0)} per-tool\n`,
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

if (params.unknown.length) {
  problems.push(
    'Tool inputs the SDK method does not accept (silently ignored at runtime):\n' +
      params.unknown
        .map(
          (u) =>
            `  ${u.tool}.${u.param} — ${u.sdkPath} accepts: ${u.accepted.join(', ') || '(nothing)'}\n` +
            `      rename it to the SDK's own name, drop it, or declare it in syntheticParams with a reason`,
        )
        .join('\n'),
  )
}

if (params.missingRequired.length) {
  problems.push(
    'Required SDK parameters no tool input supplies:\n' +
      params.missingRequired
        .map(
          (m) =>
            `  ${m.tool} never supplies ${m.sdkPath}(${m.param}) — accept it, or declare it in derivedParams with its source`,
        )
        .join('\n'),
  )
}

if (params.stale.length) {
  problems.push(
    'Parameter waivers that no longer hold:\n' +
      params.stale.map((s) => `  ${s.tool}.${s.param} ${s.why}`).join('\n'),
  )
}

if (problems.length) {
  console.error('\n' + problems.join('\n\n'))
  console.error('\nMCP is OUT OF LOCK-STEP with the SDK.')
  process.exit(1)
}

console.log('\nMCP covers the SDK surface in lock-step.')
