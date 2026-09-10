import type { EntryMeta } from '@trinaryex/keyspace'
import { ok } from '../result.js'
import { objectId, suiAddress } from '../schemas.js'
import type { ToolDef } from './types.js'

/**
 * Keyspace lookup tools.
 *
 * Keyspace is end-to-end encrypted: ciphertext lives off-chain, the Read set
 * lives on Sui, and Seal key servers release decryption shares only after
 * `keyspace::seal_approve` verifies membership — against a session key the
 * *wallet* signed. That signature is unavailable here by design, so this
 * server covers exactly the half that needs no key: discovering which
 * Keyspaces an address can read, and reading their public metadata.
 *
 * Decryption belongs wherever the private key already lives.
 */
const NO_DECRYPT_NOTE =
  ' This returns metadata only — never plaintext. Decrypting an entry requires a wallet signature for a Seal session key, which this server cannot produce; do that where the private key lives.'

export const keyspaceTools: ToolDef[] = [
  {
    name: 'keyspace_list_accessible',
    title: 'List accessible Keyspaces',
    description:
      'List the Keyspace ids an address holds any role on — the starting point for reading shared hub locations.' +
      NO_DECRYPT_NOTE,
    kind: 'read',
    sdkPath: 'keyspace.getAccessibleAcls',
    inputShape: {
      address: suiAddress.describe(
        'Sui address to look up. Public data; no signature involved.',
      ),
    },
    handler: async (ctx, args) => {
      const aclIds = await ctx.keyspaceClient().getAccessibleAcls(args.address)
      return ok({ address: args.address, aclIds, count: aclIds.length })
    },
  },
  {
    name: 'keyspace_get_acl',
    title: 'Get Keyspace detail',
    description:
      'Read one Keyspace: its role principals, epoch, and the encrypted entries it holds (id, uri, description, epoch, staleness). Use readPrincipals to check whether an address can decrypt before paying for a signature, and the per-entry fingerprint to skip re-decrypting unchanged data.' +
      NO_DECRYPT_NOTE,
    kind: 'read',
    sdkPath: 'keyspace.getAcl',
    inputShape: {
      aclId: objectId.describe('Keyspace object id.'),
    },
    handler: async (ctx, args) => {
      const acl = await ctx.keyspaceClient().getAcl(args.aclId)
      // Cache fingerprint per the Keyspace docs: an entry is unchanged while
      // the acl epoch, entry count, uri and entry epoch all hold. Comparing it
      // lets a caller skip both the wallet signature and the Seal round-trip.
      const entries = acl.entries.map((entry: EntryMeta) => ({
        ...entry,
        fingerprint: `${acl.epoch}:${acl.entryCount}:${entry.uri}:${entry.epoch}`,
      }))
      return ok({ ...acl, entries })
    },
  },
]
