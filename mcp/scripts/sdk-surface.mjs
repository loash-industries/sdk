// Derives the SDK's public client surface from its SHIPPED type declarations.
//
// Parsing `@trinaryex/sdk`'s own .d.ts — rather than reflecting over the
// runtime prototype — buys four things:
//   * `private` members are excluded structurally, with no list to maintain
//   * return types classify each method as a read or a write
//   * parameter types resolve to the property names each method accepts
//   * it describes the published contract, which is what consumers actually see
//
// Parameter names matter as much as method names: a tool can name its SDK
// method correctly and still hand it a filter key the SDK has never heard of.
// Nothing rejects that — the property is simply dropped on the way through, and
// the caller gets a successful, silently unfiltered response. Coverage alone
// cannot see it, so `diffParams` checks the arguments too.
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
  SpatialApi: 'spatial',
  OrgsApi: 'orgs',
}

/**
 * Classes whose sub-API groups are DISCOVERED rather than listed, as
 * `<class> → <namespace prefix>`.
 *
 * The Armature handle is reached as `client.org(id).<group>.<method>`, and its
 * groups grow phase by phase. A hardcoded allowlist fails OPEN for exactly that
 * shape — a new group is silently invisible until someone remembers to add it,
 * which has now happened twice (`org.treasury` and `org.orders` were both
 * missed the moment they landed). Reading the handle's own property
 * declarations instead means adding a group to the handle is all it takes.
 */
const HANDLE_ROOTS = { OrgHandle: 'org' }

/**
 * Namespaced API classes declared OUTSIDE `TriexClient.d.ts`, as
 * `<namespace> → <path relative to the declaration directory>`.
 *
 * `NAMESPACE_CLASSES` alone is not enough for these: the scan walks one file's
 * statements, so a group living in its own module is invisible no matter what
 * the map says — which is silence in exactly the place this gate exists to
 * break. A path that does not exist yet is skipped, so the gate keeps working
 * against an installed SDK predating the module.
 */
const EXTERNAL_NAMESPACE_FILES = {
  orgs: join('armature', 'OrgsApi.d.ts'),
  org: join('armature', 'OrgClient.d.ts'),
}

/**
 * Read tools call `ReadOnlyClient`, not the namespaced `TriexClient` APIs.
 *
 * Its methods are flat and take identity explicitly — `openOrders(bmId, page)`
 * rather than reading an address off client config — which is what makes one
 * server instance safe for many tenants. A parameter accepted by either client
 * is therefore legitimate, so the two are merged before checking a tool.
 */
const READ_ONLY_CLASS = 'ReadOnlyClient'

/**
 * The keyspace package's read-only client.
 *
 * Keyspace decryption needs a wallet signature, so it can never live in this
 * keyless server. Its *lookup* half can: `getAccessibleAcls` is the one call
 * that needs the Trinary API key and no signature at all, which puts it on
 * exactly the same auth plane as every other tool here.
 */
const KEYSPACE_CLASS = 'ReadOnlyAclClient'

/**
 * Return types that mark a WRITE — one that builds and submits a
 * transaction, and therefore needs a `prepare_*` tool rather than a read tool.
 */
// Return types that mean "this signs and submits a transaction". The gate
// enforces that a write is wrapped by a `prepare` tool and never by a `read`
// one, so a governance method missing from this set would be a write a read
// tool could silently swallow. `RunOutcome` is the Armature form: it resolves a
// strategy and then EXECUTES it — the `blocked` variant is a refusal to write,
// not evidence that the method is read-only.
const WRITE_RETURN_TYPES = new Set([
  'TxResult',
  'EnsureAccountResult',
  'RunOutcome',
])

/**
 * Does this return type mean "this signs and submits"?
 *
 * Exact-matching the type text is not enough: `sweepAll` returns
 * `RunOutcome & { skipped: … }`, an intersection that is every bit as much a
 * write as a bare `RunOutcome`. Classifying it as a read would let a read tool
 * cover it, which is the silent-drop the kind check exists to prevent.
 */
function isWriteReturn(text) {
  if (WRITE_RETURN_TYPES.has(text)) return true
  return [...WRITE_RETURN_TYPES].some((name) =>
    new RegExp(`\\b${name}\\b`).test(text),
  )
}

/**
 * Absolute path to a declaration file inside an installed package.
 *
 * These packages publish an `exports` map with no CJS entry, so
 * `require.resolve` cannot see them; and `import.meta.resolve` is unavailable
 * inside Jest's ESM context. Try the ESM resolver, then fall back to walking
 * up for node_modules, so the script and the test suite share one resolver.
 *
 * @param {string} packageName  e.g. `@trinaryex/sdk`
 * @param {string} fileName     declaration file within the package's dist
 * @param {string[]} segments   the package name split for the directory walk
 */
function resolvePackageDeclaration(packageName, fileName, segments) {
  const candidates = []

  if (typeof import.meta.resolve === 'function') {
    try {
      const entry = fileURLToPath(import.meta.resolve(packageName))
      candidates.push(join(dirname(entry), fileName))
    } catch {
      // fall through to the filesystem walk
    }
  }

  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(dir, 'node_modules', ...segments, 'dist', fileName))
    dir = dirname(dir)
  }

  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      `Could not locate ${packageName} type declarations — is the package installed?`,
    )
  }
  return found
}

/** Absolute path to the SDK's TriexClient declaration file. */
export function sdkDeclarationPath() {
  return resolvePackageDeclaration('@trinaryex/sdk', 'TriexClient.d.ts', [
    '@trinaryex',
    'sdk',
  ])
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

/** Strip `| undefined` / `| null` so `params?: Foo` resolves to `Foo`. */
function withoutNullish(type) {
  if (!type.isUnion?.()) return [type]
  return type.types.filter(
    (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  )
}

/**
 * Object-like types get expanded into their property names; primitives do not.
 *
 * Without this guard a `query: string` parameter would expand into every method
 * on String.prototype, and the gate would happily accept a tool input named
 * `charCodeAt`.
 */
function isObjectLike(type) {
  return Boolean(
    type.flags & ts.TypeFlags.Object || type.flags & ts.TypeFlags.Intersection,
  )
}

/**
 * The property names a method actually accepts.
 *
 * An object parameter contributes its properties — intersections such as
 * `BalancesAtHubParams & { balanceManagerId: string }` contribute both halves,
 * which the checker flattens for us. A primitive positional parameter
 * contributes its own name, so `searchItems(query, opts?)` accepts `query`
 * alongside the members of `opts`.
 *
 * @returns {{name: string, optional: boolean}[]} sorted by name
 */
function parametersOf(method, checker) {
  const accepted = new Map()

  for (const parameter of method.parameters) {
    const declaredOptional = Boolean(parameter.questionToken)
    const type = checker.getTypeAtLocation(parameter)

    // An ARRAY parameter is one value, not a bag of named options. Expanding it
    // would enumerate Array.prototype (`map`, `length`, `sort`, …) as if the
    // method accepted those names — which reads as forty missing waivers and
    // hides any real one among them. `addresses: string[]` is the first such
    // parameter in the SDK; it is named, like a scalar.
    const isArrayParam = withoutNullish(type).every(
      (t) => checker.isArrayType?.(t) ?? checker.isArrayLikeType?.(t) ?? false,
    )

    const expanded = isArrayParam
      ? []
      : withoutNullish(type).filter(isObjectLike)
    if (expanded.length === 0) {
      const name = parameter.name.getText()
      accepted.set(name, {
        name,
        optional: accepted.get(name)?.optional ?? declaredOptional,
      })
      continue
    }

    for (const constituent of expanded) {
      for (const property of constituent.getProperties()) {
        const optional =
          declaredOptional || Boolean(property.flags & ts.SymbolFlags.Optional)
        const previous = accepted.get(property.getName())
        accepted.set(property.getName(), {
          name: property.getName(),
          // A property is required only if every path to it is required.
          optional: previous ? previous.optional && optional : optional,
        })
      }
    }
  }

  return [...accepted.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Candidate `ReadOnlyClient` method names for a namespaced path.
 *
 * `orders.openOrders` flattens to `openOrders`, while `balances.atHub` becomes
 * `balancesAtHub` — so try the bare method name and the namespace-prefixed one.
 */
function readOnlyAliases(namespace, method) {
  return [method, namespace + method[0].toUpperCase() + method.slice(1)]
}

/** Merge two parameter lists, treating a name as optional if either says so. */
function mergeParams(a, b) {
  const merged = new Map()
  for (const param of [...a, ...b]) {
    const previous = merged.get(param.name)
    merged.set(param.name, {
      name: param.name,
      optional: previous ? previous.optional || param.optional : param.optional,
    })
  }
  return [...merged.values()].sort((x, y) => x.name.localeCompare(y.name))
}

/** Public methods of a flat class declaration, by name. */
function flatClassMethods(file, className, checker) {
  const methods = new Map()
  if (!file) return methods
  for (const statement of file.statements) {
    if (
      !ts.isClassDeclaration(statement) ||
      statement.name?.text !== className
    ) {
      continue
    }
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || isPrivate(member)) continue
      methods.set(member.name.getText(file), parametersOf(member, checker))
    }
  }
  return methods
}

/** Absolute path to the keyspace package's AclClient declarations. */
export function keyspaceDeclarationPath() {
  return resolvePackageDeclaration('@trinaryex/keyspace', 'AclClient.d.ts', [
    '@trinaryex',
    'keyspace',
  ])
}

/**
 * The keyspace surface this server can legitimately wrap: every public method
 * of `ReadOnlyAclClient`. All of them are reads — the package's write and
 * decrypt surfaces need an executor or a `signPersonalMessage` callback, and
 * are unreachable from a keyless server by construction.
 *
 * @returns {{path: string, namespace: string, method: string,
 *            kind: 'read', returns: string,
 *            params: {name: string, optional: boolean}[]}[]} sorted by path
 */
export function readKeyspaceSurface(
  declarationPath = keyspaceDeclarationPath(),
) {
  const program = ts.createProgram([declarationPath], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(declarationPath)
  if (!file) {
    throw new Error(`TypeScript could not load ${declarationPath}`)
  }

  const methods = flatClassMethods(file, KEYSPACE_CLASS, checker)
  const surface = [...methods.entries()].map(([method, params]) => ({
    path: `keyspace.${method}`,
    namespace: 'keyspace',
    method,
    kind: 'read',
    returns: 'unknown',
    params,
  }))

  if (surface.length === 0) {
    throw new Error(
      `No ${KEYSPACE_CLASS} methods found in ${declarationPath} — the declaration layout changed and this parser needs updating.`,
    )
  }

  return surface.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * @returns {{path: string, namespace: string, method: string,
 *            kind: 'read'|'write', returns: string,
 *            params: {name: string, optional: boolean}[]}[]} sorted by path
 */
export function readSdkSurface(declarationPath = sdkDeclarationPath()) {
  // A full Program, not a lone SourceFile: parameter types such as
  // `LimitOrderParams` are declared in sibling .d.ts files, and only a
  // TypeChecker can follow them there.
  // ReadOnlyClient is a sibling declaration that TriexClient does not import,
  // so it has to be rooted explicitly or the checker never loads it.
  const readOnlyPath = join(dirname(declarationPath), `${READ_ONLY_CLASS}.d.ts`)
  const externalFiles = Object.values(EXTERNAL_NAMESPACE_FILES)
    .map((rel) => join(dirname(declarationPath), rel))
    .filter((path) => existsSync(path))
  const roots = [
    declarationPath,
    ...(existsSync(readOnlyPath) ? [readOnlyPath] : []),
    ...externalFiles,
  ]

  const program = ts.createProgram(roots, {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(declarationPath)
  if (!file) {
    throw new Error(`TypeScript could not load ${declarationPath}`)
  }

  const readOnly = flatClassMethods(
    program.getSourceFile(readOnlyPath),
    READ_ONLY_CLASS,
    checker,
  )

  const surface = []
  const declarationFiles = [
    file,
    ...externalFiles.map((path) => program.getSourceFile(path)),
  ].filter(Boolean)

  // Merge the fixed map with whatever the handle roots declare.
  const namespaces = { ...NAMESPACE_CLASSES }
  for (const source of declarationFiles) {
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const prefix = HANDLE_ROOTS[statement.name.text]
      if (!prefix) continue
      for (const member of statement.members) {
        if (!ts.isPropertyDeclaration(member) || isPrivate(member)) continue
        const typeName = member.type?.getText(source)
        const declaredHere = declarationFiles.some((f) =>
          f.statements.some(
            (st) => ts.isClassDeclaration(st) && st.name?.text === typeName,
          ),
        )
        if (!declaredHere) continue
        namespaces[typeName] = `${prefix}.${member.name.getText(source)}`
      }
    }
  }

  for (const source of declarationFiles) {
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const namespace = namespaces[statement.name.text]
      if (!namespace) continue

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || isPrivate(member)) continue
        const method = member.name.getText(source)
        const returns = returnTypeText(member, source)
        const alias = readOnlyAliases(namespace, method).find((n) =>
          readOnly.has(n),
        )
        surface.push({
          path: `${namespace}.${method}`,
          namespace,
          method,
          kind: isWriteReturn(returns) ? 'write' : 'read',
          returns,
          params: mergeParams(
            parametersOf(member, checker),
            alias ? readOnly.get(alias) : [],
          ),
        })
      }
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
      miscovered.push({
        ...method,
        tool: tool.name,
        expected,
        actual: tool.kind,
      })
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

/** The input keys a tool declares, from its zod shape or a plain key list. */
function toolInputKeys(tool) {
  if (tool.inputKeys) return [...tool.inputKeys]
  return tool.inputShape ? Object.keys(tool.inputShape) : []
}

/**
 * Compare each tool's INPUT SHAPE against the parameters its SDK method takes.
 *
 * Wrapping the right method is only half of lock-step. A tool that declares an
 * input the SDK does not accept type-checks, passes coverage, and then quietly
 * does nothing with that argument — the SDK drops the unknown property and
 * answers as though no filter was given. That failure is invisible from the
 * outside, which is exactly why it needs a gate.
 *
 * Two escape hatches, both requiring a written reason:
 *   * `syntheticParams` — MCP-level inputs with no SDK counterpart (`sender`)
 *   * `derivedParams`   — required SDK parameters the handler supplies itself
 *
 * @returns {{unknown: object[], missingRequired: object[], stale: object[]}}
 */
export function diffParams(surface, tools, globalSynthetic = {}) {
  const byPath = new Map(surface.map((m) => [m.path, m]))

  const unknown = []
  const missingRequired = []
  const stale = []

  for (const tool of tools) {
    const method = byPath.get(tool.sdkPath)
    if (!method) continue // dangling sdkPath — diffSurface already reports it

    const accepted = new Set(method.params.map((p) => p.name))
    const synthetic = { ...globalSynthetic, ...(tool.syntheticParams ?? {}) }
    const derived = tool.derivedParams ?? {}
    const declared = toolInputKeys(tool)
    const declaredSet = new Set(declared)

    for (const key of declared) {
      if (accepted.has(key) || key in synthetic) continue
      unknown.push({
        tool: tool.name,
        sdkPath: tool.sdkPath,
        param: key,
        accepted: [...accepted].sort(),
      })
    }

    for (const param of method.params) {
      if (param.optional) continue
      if (declaredSet.has(param.name) || param.name in derived) continue
      missingRequired.push({
        tool: tool.name,
        sdkPath: tool.sdkPath,
        param: param.name,
      })
    }

    // Keep the escape hatches honest: an entry that names a real SDK parameter,
    // or one the tool no longer declares, is a stale claim rather than a waiver.
    for (const key of Object.keys(tool.syntheticParams ?? {})) {
      if (accepted.has(key)) {
        stale.push({
          tool: tool.name,
          param: key,
          why: `is a real ${tool.sdkPath} parameter, so it needs no synthetic waiver`,
        })
      } else if (!declaredSet.has(key)) {
        stale.push({
          tool: tool.name,
          param: key,
          why: 'is not in the tool input shape',
        })
      }
    }
    for (const key of Object.keys(derived)) {
      if (!accepted.has(key)) {
        stale.push({
          tool: tool.name,
          param: key,
          why: `is not a ${tool.sdkPath} parameter at all`,
        })
      } else if (declaredSet.has(key)) {
        stale.push({
          tool: tool.name,
          param: key,
          why: 'is declared in the input shape, so it is not derived',
        })
      }
    }
  }

  return { unknown, missingRequired, stale }
}
