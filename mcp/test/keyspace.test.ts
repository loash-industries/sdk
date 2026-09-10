import type { RequestContext } from '../src/context.js'
import { keyspaceTools } from '../src/tools/keyspace.js'

const tool = (name: string) => {
  const found = keyspaceTools.find((t) => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

/** A context exposing only what these handlers touch. */
const contextWith = (keyspaceClient: unknown): RequestContext =>
  ({ keyspaceClient: () => keyspaceClient }) as unknown as RequestContext

const parse = (res: { content: { text: string }[] }) =>
  JSON.parse(res.content[0]!.text)

describe('keyspace_list_accessible', () => {
  it('returns the accessible acl ids with a count', async () => {
    const ctx = contextWith({
      getAccessibleAcls: async (address: string) => {
        expect(address).toBe('0xabc')
        return ['0x1', '0x2']
      },
    })
    const body = parse(
      (await tool('keyspace_list_accessible').handler(ctx, {
        address: '0xabc',
      })) as any,
    )
    expect(body).toEqual({ address: '0xabc', aclIds: ['0x1', '0x2'], count: 2 })
  })

  it('handles an address with no accessible keyspaces', async () => {
    const ctx = contextWith({ getAccessibleAcls: async () => [] })
    const body = parse(
      (await tool('keyspace_list_accessible').handler(ctx, {
        address: '0xabc',
      })) as any,
    )
    expect(body.count).toBe(0)
    expect(body.aclIds).toEqual([])
  })
})

describe('keyspace_get_acl', () => {
  const acl = {
    id: '0xacl',
    name: 'Tribe hubs',
    epoch: 7,
    entryCount: 2,
    readPrincipals: [{ type: 'player', address: '0xreader' }],
    entries: [
      {
        id: '0xe1',
        uri: 'ipfs://aaa',
        description: 'locations',
        epoch: 3,
        isStale: false,
      },
      {
        id: '0xe2',
        uri: 'ipfs://bbb',
        description: 'notes',
        epoch: 5,
        isStale: true,
      },
    ],
  }
  const ctx = contextWith({ getAcl: async () => acl })

  it('passes through the acl metadata a caller needs before decrypting', async () => {
    const body = parse(
      (await tool('keyspace_get_acl').handler(ctx, { aclId: '0xacl' })) as any,
    )
    expect(body.epoch).toBe(7)
    expect(body.readPrincipals).toEqual([
      { type: 'player', address: '0xreader' },
    ])
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].description).toBe('locations')
    expect(body.entries[1].isStale).toBe(true)
  })

  it('adds the documented cache fingerprint to every entry', async () => {
    const body = parse(
      (await tool('keyspace_get_acl').handler(ctx, { aclId: '0xacl' })) as any,
    )
    // aclEpoch:entryCount:uri:entryEpoch — matching a fingerprint means the
    // caller can skip both the wallet signature and the Seal round-trip.
    expect(body.entries[0].fingerprint).toBe('7:2:ipfs://aaa:3')
    expect(body.entries[1].fingerprint).toBe('7:2:ipfs://bbb:5')
  })

  it('changes the fingerprint when the acl epoch moves', async () => {
    const rotated = contextWith({
      getAcl: async () => ({ ...acl, epoch: 8 }),
    })
    const before = parse(
      (await tool('keyspace_get_acl').handler(ctx, { aclId: '0xacl' })) as any,
    )
    const after = parse(
      (await tool('keyspace_get_acl').handler(rotated, {
        aclId: '0xacl',
      })) as any,
    )
    expect(after.entries[0].fingerprint).not.toBe(before.entries[0].fingerprint)
  })
})

describe('the keyless boundary', () => {
  it('registers keyspace tools as reads only', () => {
    for (const t of keyspaceTools) expect(t.kind).toBe('read')
  })

  it('asks for no key material or signature in any input', () => {
    const forbidden =
      /privateKey|signature|signPersonalMessage|sessionKey|secret|mnemonic/i
    for (const t of keyspaceTools) {
      for (const field of Object.keys(t.inputShape)) {
        expect(field).not.toMatch(forbidden)
      }
    }
  })

  it('tells the model that decryption happens elsewhere', () => {
    for (const t of keyspaceTools) {
      expect(t.description).toMatch(/requires a wallet signature/)
      expect(t.description).toMatch(/metadata only/)
    }
  })

  it('wraps only the read-only keyspace client, never the write or decrypt surface', () => {
    for (const t of keyspaceTools) {
      expect(t.sdkPath.startsWith('keyspace.')).toBe(true)
      expect(t.sdkPath).not.toMatch(
        /writeData|readData|editData|rotate|grant|revoke/,
      )
    }
  })
})
