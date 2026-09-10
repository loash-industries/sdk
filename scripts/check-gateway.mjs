#!/usr/bin/env node
// Fails when the SDK's requests have drifted from the gateway's contract.
//
//   npm run check:gateway          # against the vendored contract (hermetic)
//   npm run check:gateway -- --live # against api.trinary.exchange right now
//
// The vendored copy makes the check deterministic and offline, which is what
// unit tests need. The live mode is what catches the gateway moving underneath
// us, and it is also how the vendored copy gets refreshed:
//
//   npm run refresh:gateway
//
// Two kinds of drift, and the quiet one is the reason this exists. A moved
// endpoint 404s and announces itself. A renamed query parameter does not: the
// gateway ignores keys it does not recognise, so the call still returns 200
// with a full body, and every layer above believes it asked a narrower
// question than it did.
import { writeFileSync } from 'node:fs'
import {
  SPEC_FIXTURE,
  diffGateway,
  fetchSpec,
  loadSpec,
  readGatewaySurface,
  readSdkCalls,
} from './gateway-surface.mjs'

const live = process.argv.includes('--live')
const refresh = process.argv.includes('--refresh')

const spec = live || refresh ? await fetchSpec() : loadSpec()

if (refresh) {
  writeFileSync(SPEC_FIXTURE, JSON.stringify(spec, null, 2) + '\n')
  console.log(
    `Refreshed ${SPEC_FIXTURE.split('/').slice(-3).join('/')} — ${Object.keys(spec.paths ?? {}).length} paths, API version ${spec.info?.version ?? '?'}`,
  )
}

// A stale fixture does not break anything today, but it quietly weakens the
// hermetic test: that suite can only ever check the SDK against the contract as
// it was vendored. Say so while we have the live document in hand.
let staleFixture = false
if (live && !refresh) {
  try {
    staleFixture = JSON.stringify(loadSpec()) !== JSON.stringify(spec)
  } catch {
    staleFixture = true // missing or unreadable
  }
}

const surface = readGatewaySurface(spec)
const calls = readSdkCalls()
const diff = diffGateway(surface, calls)

console.log(
  `Gateway contract: ${surface.length} operations across ${new Set(surface.map((o) => o.path)).size} paths ` +
    `(${live || refresh ? 'live' : 'vendored'}, API version ${spec.info?.version ?? '?'})\n` +
    `SDK requests:     ${calls.length} call sites  ·  matched: ${diff.matched.length}  ·  unverifiable: ${diff.unverifiable.length}\n`,
)

console.log(
  diff.matched
    .map(
      (c) =>
        `  ✓ ${c.method.padEnd(4)} ${c.path.padEnd(58)} ${(c.query ?? []).length} param(s)`,
    )
    .join('\n'),
)

const problems = []

if (diff.unknownEndpoints.length) {
  problems.push(
    'Endpoints the gateway does not publish (these 404 at runtime):\n' +
      diff.unknownEndpoints
        .map(
          (u) =>
            `  ${u.method} ${u.path}  (${u.file}:${u.line})` +
            (u.candidates.length
              ? `\n      did you mean: ${u.candidates.join(' | ')}`
              : ''),
        )
        .join('\n'),
  )
}

if (diff.unknownParams.length) {
  problems.push(
    'Query parameters the endpoint does not declare (SILENTLY IGNORED at runtime):\n' +
      diff.unknownParams
        .map(
          (u) =>
            `  ${u.param} → ${u.method} ${u.path}  (${u.file}:${u.line})\n` +
            `      declares: ${u.declared.join(', ') || '(no query parameters)'}`,
        )
        .join('\n'),
  )
}

if (diff.missingRequired.length) {
  problems.push(
    'Required query parameters the SDK never sends:\n' +
      diff.missingRequired
        .map(
          (m) => `  ${m.param} → ${m.method} ${m.path}  (${m.file}:${m.line})`,
        )
        .join('\n'),
  )
}

if (diff.unverifiable.length) {
  problems.push(
    'Call sites this check could not read statically:\n' +
      diff.unverifiable
        .map(
          (u) =>
            `  ${u.file}:${u.line} — build the path and query as literals, or the gateway contract cannot be checked here`,
        )
        .join('\n'),
  )
}

if (staleFixture) {
  console.warn(
    '\nThe vendored contract differs from the live one. Nothing is broken —\n' +
      'the SDK was just checked against the live document and matched — but the\n' +
      'offline suite is still testing against the older copy. Run:\n' +
      '\n  npm run refresh:gateway\n',
  )
}

if (problems.length) {
  console.error('\n' + problems.join('\n\n'))
  console.error(
    `\nSDK is OUT OF LOCK-STEP with the gateway${live ? ' (live)' : ''}.`,
  )
  process.exit(1)
}

console.log(
  `\nSDK matches the gateway contract.` +
    `\n${diff.unusedEndpoints.length} published operation(s) the SDK does not wrap — informational, not a failure.`,
)
