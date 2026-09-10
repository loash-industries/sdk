// Derives two surfaces and compares them: the gateway's PUBLISHED OpenAPI
// contract, and the requests this SDK actually issues.
//
// The SDK is the layer that talks to `api.trinary.exchange`, so its own drift
// has the same two shapes the MCP package's parity gate watches for one layer
// up:
//
//   * an endpoint that moved or was renamed — loud at runtime, a 404
//   * a query parameter the endpoint does not declare — SILENT at runtime
//
// The second is why this exists. A gateway ignores query keys it does not
// recognise; it does not reject them. So a renamed filter keeps returning
// 200s with a full, unfiltered body, and every caller above believes it asked
// a narrower question than it did. Nothing in a type system sees that, and no
// integration test that only asserts "the call succeeded" sees it either.
//
// Call sites are read from the TypeScript source rather than intercepted at
// runtime, so the check needs no API key, no network, and no live account —
// it runs in the same millisecond budget as a unit test.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))

/** Where the vendored copy of the gateway contract lives. */
export const SPEC_FIXTURE = join(
  here,
  '..',
  'test',
  'fixtures',
  'gateway-openapi.json',
)

/** The published contract, fetched live. */
export const SPEC_URL = 'https://api.trinary.exchange/swagger.json'

/**
 * Reduce a path to a shape that can be compared across the two sources.
 *
 * The spec writes `/v1/hubs/{hub_id}/items`; the SDK writes
 * `/v1/hubs/${encodeURIComponent(hubId)}/items`. Both become
 * `/v1/hubs/{}/items` — the parameter NAMES differ by convention on each side
 * and carry no meaning across the boundary, but the arity and the literal
 * segments do.
 */
export function normalizePath(path) {
  return path
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/+$/, '')
}

/** Load an OpenAPI document from disk. */
export function loadSpec(specPath = SPEC_FIXTURE) {
  return JSON.parse(readFileSync(specPath, 'utf8'))
}

/** Load the live OpenAPI document. Used by the drift check, never by tests. */
export async function fetchSpec(url = SPEC_URL) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`Could not fetch the gateway contract: HTTP ${res.status}`)
  }
  return res.json()
}

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
])

/**
 * Every operation the gateway publishes.
 *
 * Parameters declared on the path item apply to all of its operations, so they
 * are merged into each one — a spec may legally put shared path parameters
 * either place.
 *
 * @returns {{path: string, normalized: string, method: string,
 *            operationId: string|undefined,
 *            query: {name: string, required: boolean}[],
 *            pathParams: string[]}[]}
 */
export function readGatewaySurface(spec = loadSpec()) {
  const operations = []

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = item.parameters ?? []
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue

      const parameters = [...shared, ...(operation.parameters ?? [])]
      operations.push({
        path,
        normalized: normalizePath(path),
        method: method.toUpperCase(),
        operationId: operation.operationId,
        query: parameters
          .filter((p) => p.in === 'query')
          .map((p) => ({ name: p.name, required: Boolean(p.required) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        pathParams: parameters
          .filter((p) => p.in === 'path')
          .map((p) => p.name),
      })
    }
  }

  if (operations.length === 0) {
    throw new Error(
      'No operations found in the gateway contract — the document layout changed and this parser needs updating.',
    )
  }

  return operations.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  )
}

/** Text of a string or template literal, with interpolations left as `${}`. */
function literalPath(node, source) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => `\${}${span.literal.text}`).join('')
    )
  }
  return undefined
}

/**
 * Query keys in an object literal argument.
 *
 * `undefined` (the common "no query" placeholder) yields an empty list, which
 * is different from a call that passes no argument at all only in intent, not
 * in effect.
 */
function queryKeys(node) {
  if (!node || node.kind === ts.SyntaxKind.UndefinedKeyword) return []
  if (
    node.kind === ts.SyntaxKind.Identifier &&
    node.getText() === 'undefined'
  ) {
    return []
  }
  if (!ts.isObjectLiteralExpression(node)) return undefined

  const keys = []
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return undefined // not statically knowable
    const name = property.name
    if (!name) continue
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      keys.push(name.text)
    } else {
      return undefined // computed key — give up rather than guess
    }
  }
  return keys.sort()
}

/**
 * Every gateway request this SDK issues, read from its source.
 *
 * Matches `this.<helper>(path, query?)` calls, where the helper is one of
 * `methodNames`. A call whose path or query cannot be read statically is
 * returned with `dynamic: true` rather than dropped, so the gate can report
 * what it could not verify instead of quietly passing it.
 *
 * @returns {{path: string, normalized: string, method: string,
 *            query: string[]|undefined, dynamic: boolean,
 *            file: string, line: number}[]}
 */
export function readSdkCalls(
  files = [join(here, '..', 'src', 'queries.ts')],
  methodNames = { get: 'GET' },
) {
  const calls = []

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    )

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const helper = node.expression.name.text
        const method = methodNames[helper]
        if (method) {
          const path = literalPath(node.arguments[0], source)
          const query = queryKeys(node.arguments[1])
          const { line } = source.getLineAndCharacterOfPosition(node.getStart())
          calls.push({
            path: path ?? '(dynamic)',
            normalized: path ? normalizePath(path) : '(dynamic)',
            method,
            query,
            dynamic: path === undefined || query === undefined,
            file: file.split('/').slice(-2).join('/'),
            line: line + 1,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  if (calls.length === 0) {
    throw new Error(
      'No gateway calls found in the SDK source — the request layer changed and this parser needs updating.',
    )
  }

  return calls.sort(
    (a, b) => a.normalized.localeCompare(b.normalized) || a.line - b.line,
  )
}

/**
 * Compare what the SDK sends against what the gateway declares.
 *
 * @returns {{unknownEndpoints: object[], unknownParams: object[],
 *            missingRequired: object[], unverifiable: object[],
 *            matched: object[], unusedEndpoints: object[]}}
 */
export function diffGateway(surface, calls, options = {}) {
  const allowedExtraParams = new Set(options.allowedExtraParams ?? [])

  const byKey = new Map(
    surface.map((op) => [`${op.method} ${op.normalized}`, op]),
  )

  const unknownEndpoints = []
  const unknownParams = []
  const missingRequired = []
  const unverifiable = []
  const matched = []
  const used = new Set()

  for (const call of calls) {
    if (call.dynamic) {
      unverifiable.push(call)
      continue
    }

    const key = `${call.method} ${call.normalized}`
    const operation = byKey.get(key)
    if (!operation) {
      unknownEndpoints.push({
        ...call,
        // Near misses are almost always the real answer: a renamed segment or
        // a changed arity, not a wholly invented endpoint.
        candidates: surface
          .filter(
            (op) =>
              op.normalized.split('/')[2] === call.normalized.split('/')[2],
          )
          .map((op) => `${op.method} ${op.path}`)
          .slice(0, 5),
      })
      continue
    }

    used.add(key)
    const declared = new Set(operation.query.map((p) => p.name))

    for (const name of call.query ?? []) {
      if (declared.has(name) || allowedExtraParams.has(name)) continue
      unknownParams.push({
        ...call,
        param: name,
        declared: [...declared].sort(),
      })
    }

    for (const parameter of operation.query) {
      if (!parameter.required) continue
      if ((call.query ?? []).includes(parameter.name)) continue
      missingRequired.push({ ...call, param: parameter.name })
    }

    matched.push({ ...call, operationId: operation.operationId })
  }

  return {
    unknownEndpoints,
    unknownParams,
    missingRequired,
    unverifiable,
    matched,
    // Informational only: the gateway serves far more than this SDK wraps.
    unusedEndpoints: surface.filter(
      (op) => !used.has(`${op.method} ${op.normalized}`),
    ),
  }
}
