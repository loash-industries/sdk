import { ALL_TOOLS, EXCLUDED_SDK_PATHS } from '../src/registry.js'
import { orgPrepareTools } from '../src/tools/orgPrepare.js'
import { orgTools } from '../src/tools/org.js'

/**
 * Behaviour specific to the Armature tools.
 *
 * The parity suite already checks that every SDK method has a tool and that no
 * tool offers an input its method ignores. What it cannot check is the thing
 * these tools do differently from every other prepare tool: a governance action
 * has THREE outcomes, not one, and two of them produce no transaction.
 */

const ORG = '0x'.padEnd(66, 'c')
const SENDER = '0x'.padEnd(66, 'a')
const OTHER = '0x'.padEnd(66, 'b')

/**
 * A context whose `writeClient` returns a stub organization handle. The tools
 * only ever reach the handle through `client.org(...)`, so a stub is enough to
 * drive the outcome paths without a chain.
 */
function ctxWith(handle: Record<string, unknown>) {
  return {
    apiKey: 'k',
    config: {} as never,
    readClient: () => ({}) as never,
    keyspaceClient: () => ({}) as never,
    suiClient: () => ({}) as never,
    writeClient: () => ({ org: async () => handle }) as never,
  } as never
}

const tool = (name: string) => {
  const t = [...orgTools, ...orgPrepareTools].find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

describe('governance outcomes reach the caller', () => {
  it('reports prepared:false and the resolver’s reason when blocked', async () => {
    const ctx = ctxWith({
      members: {
        add: async () => ({
          status: 'blocked',
          code: 'not-member',
          reason: 'You are not on this unit’s board (or its parent’s).',
        }),
      },
    })
    const res = await tool('prepare_org_add_members').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      addresses: [OTHER],
    })
    const body = JSON.parse(res.content[0]!.text)

    // A refusal is an ANSWER, not an error — and it must not look like a
    // transaction the caller could sign.
    expect(body.prepared).toBe(false)
    expect(body.code).toBe('not-member')
    expect(body.reason).toContain('not on this unit')
    expect(body.txKindBytes).toBeUndefined()
  })

  it('says nothing was needed when the SDK simply did not write', async () => {
    // No executor call and no blocked status: the capture layer reports
    // NothingToPrepare, which must not be dressed up as a refusal.
    const ctx = ctxWith({
      members: { add: async () => ({ status: 'executed' }) },
    })
    const res = await tool('prepare_org_add_members').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      addresses: [OTHER],
    })
    const body = JSON.parse(res.content[0]!.text)
    expect(body.prepared).toBe(false)
    expect(body.code).toBeNull()
    expect(body.reason).toContain('No transaction is needed')
  })
})

describe('tool surface shape', () => {
  it('every org prepare tool is a prepare, every org read tool is a read', () => {
    expect(orgTools.every((t) => t.kind === 'read')).toBe(true)
    expect(orgPrepareTools.every((t) => t.kind === 'prepare')).toBe(true)
  })

  it('every org prepare tool names the sender it builds for', () => {
    for (const t of orgPrepareTools) {
      expect(Object.keys(t.inputShape)).toContain('sender')
    }
  })

  it('unit-scoped tools take an explicit address — this server is keyless', () => {
    const unitScoped = orgTools.filter((t) => t.sdkPath.startsWith('org.'))
    expect(unitScoped.length).toBeGreaterThan(0)
    for (const t of unitScoped) {
      expect(Object.keys(t.inputShape)).toContain('address')
    }
  })

  it('names are unique across the whole registry', () => {
    const names = ALL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('excludes the closure-bearing generics, and says why', () => {
    for (const path of [
      'org.governance.run',
      'org.governance.runBatch',
      'org.governance.runComposite',
      'org.governance.resolve',
      'org.governance.paths',
      'org.governance.canComposite',
    ]) {
      expect(EXCLUDED_SDK_PATHS[path]).toBeDefined()
    }
    // The reason has to name the actual obstacle, not just assert one.
    expect(EXCLUDED_SDK_PATHS['org.governance.run']).toMatch(
      /OuProposalAction|closure/i,
    )
  })
})

describe('irreversible options are called out in the description', () => {
  it('enable_trading warns about binding to one base coin', () => {
    const t = tool('prepare_org_enable_trading')
    expect(t.description).toMatch(/IRREVERSIBLE/)
    expect(t.description).toMatch(/one base coin|ONE base coin/)
  })

  it('treasury payouts warn that they may become proposals', () => {
    expect(tool('prepare_org_treasury_send').description).toMatch(
      /PROPOSAL|proposal/,
    )
  })

  it('sweep_all promises to report what it skipped', () => {
    expect(tool('prepare_org_sweep_all').description).toMatch(/skipped/)
  })
})
