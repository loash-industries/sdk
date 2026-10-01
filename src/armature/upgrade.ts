import { fromBase64 } from '@mysten/sui/utils'
import type { Transaction } from '@mysten/sui/transactions'

import { TriexClientError, TriexError } from '../errors'
import type { ArmaturePkgs } from './actions'
import { PERMISSIONS } from './governance'
import type { OuProposalAction } from './harness'

/**
 * Governed package upgrades (`armature_proposals::upgrade`, cycle 7).
 *
 * An OU that custodies a package's `UpgradeCap` (moved into its capability
 * vault, e.g. by `TransferAssets` or `TransferCapToSubOU`) upgrades it by
 * vote: `ProposeUpgrade { cap_id, package_id, digest, policy }`. Execution is
 * three commands that must share ONE PTB — `execute_propose_upgrade` loans the
 * cap and returns an `UpgradeTicket` + a `PendingUpgrade` hot potato, the PTB
 * `Upgrade` command publishes the new modules, and `commit_upgrade` returns
 * the cap to the vault. The SDK therefore needs the compiled package to
 * EXECUTE (not to propose); `digest` must match it or the upgrade aborts.
 */

/** The compiled package an upgrade publishes (`sui move build --dump-bytecode-as-base64`). */
export interface UpgradeBuild {
  /** Base64 module bytecode, or raw bytes per module. */
  modules: (string | number[] | Uint8Array)[]
  /** Dependency package ids. */
  dependencies: string[]
}

/** `sui::package` upgrade policies. */
export const UPGRADE_POLICY = {
  COMPATIBLE: 0,
  ADDITIVE: 128,
  DEP_ONLY: 192,
} as const

function asBytes(m: string | number[] | Uint8Array): number[] {
  if (typeof m === 'string') return Array.from(fromBase64(m))
  return Array.from(m)
}

/**
 * Append the three-command upgrade execution for one `ProposeUpgrade` ticket.
 * @internal — the action's `buildExecute` and `governance.execute` share it.
 */
export function appendUpgradeExecution(
  tx: Transaction,
  args: {
    armatureProposals: string
    capabilityVaultId: string
    packageId: string
    ticket: ReturnType<Transaction['moveCall']>
    build: UpgradeBuild
  },
): void {
  const [upgradeTicket, pending] = tx.moveCall({
    target: `${args.armatureProposals}::upgrade_ops::execute_propose_upgrade`,
    arguments: [tx.object(args.capabilityVaultId), args.ticket],
  })
  const receipt = tx.upgrade({
    modules: args.build.modules.map(asBytes),
    dependencies: args.build.dependencies,
    package: args.packageId,
    ticket: upgradeTicket,
  })
  tx.moveCall({
    target: `${args.armatureProposals}::upgrade_ops::commit_upgrade`,
    arguments: [tx.object(args.capabilityVaultId), pending, receipt],
  })
}

/**
 * Propose (and, on a single-vote path, perform) a package upgrade.
 *
 * `build` is required only to EXECUTE — the single-vote path, or later via
 * `governance.execute(proposalId, { upgrade })`. Without it the action can
 * still be proposed; on an immediate path it throws rather than build a
 * half-transaction. Holds `VAULT_BORROW` scoped to `UpgradeCap`.
 */
export function proposeUpgradeAction(
  pkgs: ArmaturePkgs,
  params: {
    capId: string
    packageId: string
    /** The new package's digest (32 bytes). */
    digest: number[] | Uint8Array
    policy?: number
    capabilityVaultId: string
    build?: UpgradeBuild
  },
): OuProposalAction {
  const { armatureProposals: p } = pkgs
  return {
    kind: 'propose_upgrade',
    own: {
      typeKey: 'ProposeUpgrade',
      payloadMoveType: `${p}::propose_upgrade::ProposeUpgrade`,
      requiredPermissions: PERMISSIONS.VAULT_BORROW,
      requiredBorrowScope: ['0x2::package::UpgradeCap'],
      buildPayload: (tx) =>
        tx.moveCall({
          target: `${p}::propose_upgrade::new`,
          arguments: [
            tx.pure.id(params.capId),
            tx.pure.id(params.packageId),
            tx.pure.vector('u8', Array.from(params.digest)),
            tx.pure.u8(params.policy ?? UPGRADE_POLICY.COMPATIBLE),
          ],
        }),
      buildExecute: (tx, ticket) => {
        if (!params.build) {
          throw new TriexClientError(
            TriexError.ValidationFailed,
            'Executing an upgrade needs the compiled package — pass `build: { modules, dependencies }`.',
          )
        }
        appendUpgradeExecution(tx, {
          armatureProposals: p,
          capabilityVaultId: params.capabilityVaultId,
          packageId: params.packageId,
          ticket,
          build: params.build,
        })
      },
    },
    fallbackPolicy: 'fall-back-to-proposal',
  }
}
