import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { OrgHandle } from '@trinaryex/sdk'
import { TransactionCaptured, captureExecutor } from '../src/capture.js'
import { ALL_TOOLS, EXCLUDED_SDK_PATHS } from '../src/registry.js'
import { orgLifecycleTools } from '../src/tools/orgLifecycle.js'
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
function ctxWith(
  handle: unknown,
  extra: { suiClient?: unknown; readClient?: unknown; orgs?: unknown } = {},
) {
  return {
    apiKey: 'k',
    config: {} as never,
    readClient: () => (extra.readClient ?? {}) as never,
    keyspaceClient: () => ({}) as never,
    suiClient: () => (extra.suiClient ?? {}) as never,
    writeClient: () =>
      ({ org: async () => handle, orgs: extra.orgs ?? {} }) as never,
  } as never
}

const tool = (name: string) => {
  const t = [...orgTools, ...orgPrepareTools, ...orgLifecycleTools].find(
    (x) => x.name === name,
  )
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
    expect(
      [...orgPrepareTools, ...orgLifecycleTools].every(
        (t) => t.kind === 'prepare',
      ),
    ).toBe(true)
  })

  it('every org prepare tool names the sender it builds for', () => {
    for (const t of [...orgPrepareTools, ...orgLifecycleTools]) {
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
  it('irreversible lifecycle steps say so', () => {
    expect(tool('prepare_org_unit_spin_out').description).toMatch(
      /IRREVERSIBLE/,
    )
    expect(tool('prepare_org_spawn_successor').description).toMatch(
      /IRREVERSIBLE/,
    )
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

// ─── cycle 7 ──────────────────────────────────────────────────────────────────

const ARM = normalizeSuiAddress('0x' + 'ab'.repeat(32))
const DIGEST = '11111111111111111111111111111111'
const body = (res: { content: { text: string }[] }) =>
  JSON.parse(res.content[0]!.text)

/**
 * A transaction shaped like the one a governance strategy builds: the
 * board_voting entry point it calls is what separates "executes now" from
 * "creates a proposal". Pure arguments only, so it builds with no fullnode.
 */
function governanceTx(fn: string): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${ARM}::board_voting::${fn}`,
    arguments: [tx.pure.u64(1n)],
  })
  return tx
}

/** A handle method that builds `tx` and hands it to the capture executor. */
const builds = (tx: Transaction) => async () => {
  throw new TransactionCaptured(tx)
}

/**
 * A fullnode stub just capable enough for Transaction#build: every object is
 * shared, and every Move function takes `arity[name]` `&mut` objects.
 */
function fakeSui(arity: Record<string, number>): any {
  const impl: Record<string, (args: any) => any> = {
    getObjects: ({ objectIds }: { objectIds: string[] }) => ({
      objects: objectIds.map((objectId) => ({
        objectId,
        version: '7',
        digest: DIGEST,
        owner: { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
      })),
    }),
    getMoveFunction: ({ name }: { name: string }) => ({
      function: {
        parameters: Array.from({ length: arity[name] ?? 0 }, () => ({
          reference: 'mutable',
          body: {
            $kind: 'datatype',
            datatype: { typeName: '0x2::object::UID', typeParameters: [] },
          },
        })),
      },
    }),
  }
  return {
    core: new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === 'resolveTransactionPlugin'
            ? () => undefined
            : async (args: any) => {
                const fn = impl[name]
                if (!fn) throw new Error(`core.${name} not stubbed`)
                return fn(args)
              },
      },
    ),
  }
}

/** A REAL SDK handle over a one-unit organization, wired to capture. */
function realHandle(suiClient: unknown) {
  return new OrgHandle(
    {
      suiClient,
      indexer: {},
      ids: { armature: ARM },
      requireExecutor: () => captureExecutor,
      address: SENDER,
    } as never,
    {
      orgId: ORG,
      name: 'Test org',
      ous: [],
      members: [SENDER],
      charterId: null,
      treasuryId: null,
      capabilityVaultId: null,
      emergencyFreezeId: null,
      tradingAccountId: null,
      subdaoControlCapId: null,
    } as never,
  )
}

describe('intent.outcome is read off the bytes', () => {
  it('reports "executed" when the strategy votes and executes in one PTB', async () => {
    const ctx = ctxWith({
      treasury: { send: builds(governanceTx('submit_vote_execute')) },
    })
    const res = await tool('prepare_org_treasury_send').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      recipient: OTHER,
      amount: '100',
    })
    const out = body(res)
    expect(out.intent.outcome).toBe('executed')
    expect(out.intent.params.outcome).toBe('executed')
    expect(out.intent.targets).toEqual([
      `${ARM}::board_voting::submit_vote_execute`,
    ])
    expect(out.notes.join(' ')).not.toMatch(/CREATE a proposal/)
  })

  it('reports "proposed" when the bytes only submit a proposal', async () => {
    // The capture executor intercepts the build before the SDK shapes its
    // RunOutcome, so this must come from the transaction — not default to
    // "executed", which would tell the caller a payment happened that has not.
    const ctx = ctxWith({
      treasury: { send: builds(governanceTx('submit_proposal')) },
    })
    const res = await tool('prepare_org_treasury_send').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      recipient: OTHER,
      amount: '100',
    })
    const out = body(res)
    expect(out.intent.outcome).toBe('proposed')
    expect(out.intent.params.outcome).toBe('proposed')
    expect(out.notes.join(' ')).toMatch(/CREATE a proposal/)
  })

  it('a blocked cycle-7 write is prepared:false with the reason', async () => {
    const ctx = ctxWith({
      currency: {
        mint: async () => ({
          status: 'blocked',
          code: 'type-not-enabled',
          reason: 'MintCoin<T> is not enabled on this unit.',
        }),
      },
    })
    const out = body(
      await tool('prepare_org_currency_mint').handler(ctx, {
        orgId: ORG,
        sender: SENDER,
        coinType: '0x2::sui::SUI',
        treasuryCapId: OTHER,
        amount: '5',
      }),
    )
    expect(out.prepared).toBe(false)
    expect(out.code).toBe('type-not-enabled')
    expect(out.reason).toMatch(/not enabled/)
  })
})

describe('cycle-7 arguments reach the SDK', () => {
  it('forwards RunOptions (unitId, metadataIpfs) as the second argument', async () => {
    let seen: unknown[] = []
    const ctx = ctxWith({
      types: {
        disable: async (...a: unknown[]) => {
          seen = a
          return { status: 'blocked', code: 'x', reason: 'stub' }
        },
      },
    })
    await tool('prepare_org_disable_type').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      typeKey: 'SendCoin',
      unitId: OTHER,
      metadataIpfs: 'ipfs://why',
    })
    expect(seen).toEqual([
      'SendCoin',
      { unitId: OTHER, metadataIpfs: 'ipfs://why' },
    ])
  })

  it('set_board sends a diff, not a replacement roster', async () => {
    let seen: unknown[] = []
    const ctx = ctxWith({
      members: {
        setBoard: async (...a: unknown[]) => {
          seen = a
          return { status: 'blocked', code: 'x', reason: 'stub' }
        },
      },
    })
    await tool('prepare_org_set_board').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      add: [OTHER],
      remove: [SENDER],
    })
    expect(seen[0]).toEqual({ add: [OTHER], remove: [SENDER] })
  })

  it('renamed inputs use the SDK’s cycle-7 names', async () => {
    const calls: Record<string, any> = {}
    const record =
      (name: string) =>
      async (p: unknown): Promise<unknown> => {
        calls[name] = p
        return { status: 'blocked', code: 'x', reason: 'stub' }
      }
    const ctx = ctxWith({
      vault: { grant: record('grant') },
      orders: {
        sweepCoin: record('sweepCoin'),
        sellFromVault: record('sellFromVault'),
      },
    })

    await tool('prepare_org_vault_grant').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      vaultId: OTHER,
      editorOuId: ORG,
      grants: [{ role: 'deposit', kind: 'machine', value: OTHER }],
    })
    expect(calls.grant).toEqual({
      vaultId: OTHER,
      editorOuId: ORG,
      grants: [
        { role: 'deposit', principal: { kind: 'machine', value: OTHER } },
      ],
    })

    await tool('prepare_org_sweep_coin').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      amount: '10',
      coinType: '0x2::sui::SUI',
      claimFromCoinPool: { poolId: OTHER, baseType: '0x2::sui::SUI' },
    })
    expect(calls.sweepCoin.coinType).toBe('0x2::sui::SUI')
    expect(calls.sweepCoin.claimFromCoinPool).toEqual({
      poolId: OTHER,
      baseType: '0x2::sui::SUI',
    })

    await tool('prepare_org_sell_from_vault').handler(ctx, {
      orgId: ORG,
      sender: SENDER,
      storageUnitId: OTHER,
      assetId: '1',
      price: '2',
      quantity: '3',
      vaultId: OTHER,
    })
    expect(calls.sellFromVault.vaultId).toBe(OTHER)
    expect(calls.sellFromVault.side).toBe('sell')

    // The old spellings are gone from the published input shapes.
    for (const name of [
      'prepare_org_sweep_items',
      'prepare_org_vault_deposit',
      'prepare_org_vault_withdraw',
      'prepare_org_sell_from_vault',
    ]) {
      const keys = Object.keys(tool(name).inputShape)
      expect(keys).toContain('vaultId')
      expect(keys).not.toContain('daoVaultId')
    }
    for (const name of [
      'prepare_org_vault_grant',
      'prepare_org_vault_revoke',
      'prepare_org_vault_deinit',
    ]) {
      const keys = Object.keys(tool(name).inputShape)
      expect(keys).toContain('editorOuId')
      expect(keys).not.toContain('editorDaoId')
    }
    expect(
      Object.keys(tool('prepare_org_sweep_coin').inputShape),
    ).not.toContain('quoteType')
  })
})

describe('proposal cleanup builds the real cycle-7 calls', () => {
  it('delete_expired targets proposal::delete_expired_proposal once per id', async () => {
    const sui = fakeSui({ delete_expired_proposal: 2 })
    const ctx = ctxWith(realHandle(sui), { suiClient: sui })
    const P1 = '0x'.padEnd(66, '1')
    const P2 = '0x'.padEnd(66, '2')
    const payload = `${ARM}::set_board::SetBoard`

    const out = body(
      await tool('prepare_org_delete_expired_proposals').handler(ctx, {
        orgId: ORG,
        sender: SENDER,
        proposalIds: [P1, P2],
        payloadTypes: { [P1]: payload, [P2]: payload },
      }),
    )

    expect(out.intent.targets).toEqual([
      `${ARM}::proposal::delete_expired_proposal`,
      `${ARM}::proposal::delete_expired_proposal`,
    ])
    // Permissionless cleanup is not a governance decision.
    expect(out.intent.outcome).toBe('executed')
    expect(
      out.pinnedObjects.map((o: { objectId: string }) => o.objectId),
    ).toEqual(expect.arrayContaining([P1, P2]))
  })

  it('delete_exhausted_frame targets composite::delete_exhausted_frame', async () => {
    const sui = fakeSui({ delete_exhausted_frame: 1 })
    const ctx = ctxWith(realHandle(sui), { suiClient: sui })
    const FRAME = '0x'.padEnd(66, '3')
    const out = body(
      await tool('prepare_org_delete_exhausted_frame').handler(ctx, {
        orgId: ORG,
        sender: SENDER,
        frameId: FRAME,
      }),
    )
    expect(out.intent.targets).toEqual([
      `${ARM}::composite::delete_exhausted_frame`,
    ])
  })
})

describe('sweep_all reports what it will skip', () => {
  it('lists unlinked and vault-less stacks in intent.params.skipped', async () => {
    const SU = '0x'.padEnd(66, '5')
    const handle = {
      seat: { daoId: ORG },
      seats: [{ daoId: ORG }],
      nodes: [{ daoId: ORG, tradingAccountId: OTHER }],
      vault: { resolve: async () => null },
      orders: { sweepAll: builds(governanceTx('submit_vote_execute')) },
    }
    const ctx = ctxWith(handle, {
      readClient: {
        sweepable: async (id: string) => {
          expect(id).toBe(OTHER)
          return {
            pools: [],
            items: [
              { storageUnitId: '', assetId: '7', amount: 1n },
              { storageUnitId: SU, assetId: '8', amount: 2n },
            ],
          }
        },
      },
    })
    const out = body(
      await tool('prepare_org_sweep_all').handler(ctx, {
        orgId: ORG,
        sender: SENDER,
      }),
    )
    expect(out.intent.params.skipped).toEqual([
      { storageUnitId: '', assetId: '7', amount: '1', reason: 'unlinked' },
      { storageUnitId: SU, assetId: '8', amount: '2', reason: 'no-vault' },
    ])
  })
})

describe('organization creation', () => {
  it('prepare_org_create builds through orgs.create, not a handle', async () => {
    let seen: any
    const ctx = ctxWith(
      {},
      {
        orgs: {
          create: async (p: unknown) => {
            seen = p
            throw new TransactionCaptured(governanceTx('noop'))
          },
        },
      },
    )
    const out = body(
      await tool('prepare_org_create').handler(ctx, {
        sender: SENDER,
        name: 'Acme',
        metadataUri: 'ipfs://acme',
        enableTrading: false,
      }),
    )
    expect(seen).toMatchObject({
      name: 'Acme',
      metadataUri: 'ipfs://acme',
      enableTrading: false,
    })
    expect(out.intent.action).toBe('org_create')
    expect(out.sender).toBe(SENDER)
  })
})
