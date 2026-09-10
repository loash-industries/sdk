// Derives the SDK's public client surface from its SHIPPED type declarations.
//
// Parsing `@trinaryex/sdk`'s own .d.ts — rather than reflecting over the
// runtime prototype — buys three things:
//   * `private` members are excluded structurally, with no list to maintain
//   * return types classify each method as a read or a write
//   * it describes the published contract, which is what consumers actually see
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Client namespace classes, mapped to their accessor on TriexClient. */
const NAMESPACE_CLASSES = {
  AccountApi: 'account',
  BalancesApi: 'balances',
  MarketApi: 'market',
  OrdersApi: 'orders',
}

/**
 * Return types that mark a method as a WRITE — one that builds and submits a
 * transaction, and therefore needs a `prepare_*` tool rather than a read tool.
 */
const WRITE_RETURN_TYPES = new Set(['TxResult', 'EnsureAccountResult'])

/**
 * Absolute path to the SDK's TriexClient declaration file.
 *
 * The package publishes an `exports` map with no CJS entry, so
 * `require.resolve` cannot see it; and `import.meta.resolve` is unavailable
 * inside Jest's ESM context. Try the ESM resolver, then fall back to walking
 * up for node_modules, so the script and the test suite share one resolver.
 */
export function sdkDeclarationPath() {
  const candidates = []

  if (typeof import.meta.resolve === 'function') {
    try {
      const entry = fileURLToPath(import.meta.resolve('@trinaryex/sdk'))
      candidates.push(join(dirname(entry), 'TriexClient.d.ts'))
    } catch {
      // fall through to the filesystem walk
    }
  }

  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i += 1) {
    candidates.push(
      join(dir, 'node_modules', '@trinaryex', 'sdk', 'dist', 'TriexClient.d.ts'),
    )
    dir = dirname(dir)
  }

  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      'Could not locate @trinaryex/sdk type declarations — is the package installed?',
    )
  }
  return found
}

function returnTypeText(method, source) {
  if (!method.type) return 'unknown'
  const text = method.type.getText(source)
  const promise = /^Promise<([\s\S]*)>$/.exec(text.trim())
  return (promise ? promise[1] : text).trim()
}

function isPrivate(method) {
  const modifiers = ts.getModifiers?.(method) ?? method.modifiers ?? []
  return (
    modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ||
    ts.isPrivateIdentifier(method.name)
  )
}

/**
 * @returns {{path: string, namespace: string, method: string,
 *            kind: 'read'|'write', returns: string}[]} sorted by path
 */
export function readSdkSurface(declarationPath = sdkDeclarationPath()) {
  const file = ts.createSourceFile(
    declarationPath,
    ts.sys.readFile(declarationPath) ?? '',
    ts.ScriptTarget.ES2022,
    true,
  )

  const surface = []
  for (const statement of file.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue
    const namespace = NAMESPACE_CLASSES[statement.name.text]
    if (!namespace) continue

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || isPrivate(member)) continue
      const method = member.name.getText(file)
      const returns = returnTypeText(member, file)
      surface.push({
        path: `${namespace}.${method}`,
        namespace,
        method,
        kind: WRITE_RETURN_TYPES.has(returns) ? 'write' : 'read',
        returns,
      })
    }
  }

  if (surface.length === 0) {
    throw new Error(
      `No SDK client methods found in ${declarationPath} — the declaration layout changed and this parser needs updating.`,
    )
  }

  return surface.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Compare the SDK surface against the MCP tool registry.
 *
 * @returns {{missing: object[], miscovered: object[], dangling: string[],
 *            staleExclusions: string[], covered: object[]}}
 */
export function diffSurface(surface, tools, excluded) {
  const byPath = new Map(tools.map((t) => [t.sdkPath, t]))
  const excludedPaths = new Set(Object.keys(excluded))
  const surfacePaths = new Set(surface.map((m) => m.path))

  const missing = []
  const miscovered = []
  const covered = []

  for (const method of surface) {
    if (excludedPaths.has(method.path)) continue
    const tool = byPath.get(method.path)
    if (!tool) {
      missing.push(method)
      continue
    }
    // A write must be wrapped by a prepare tool and a read by a read tool —
    // covering a write with a read tool would silently drop the write.
    const expected = method.kind === 'write' ? 'prepare' : 'read'
    if (tool.kind !== expected) {
      miscovered.push({ ...method, tool: tool.name, expected, actual: tool.kind })
    } else {
      covered.push({ ...method, tool: tool.name })
    }
  }

  return {
    missing,
    miscovered,
    covered,
    dangling: tools.map((t) => t.sdkPath).filter((p) => !surfacePaths.has(p)),
    staleExclusions: [...excludedPaths].filter((p) => !surfacePaths.has(p)),
  }
}
