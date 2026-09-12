import type { PackageIds, TriexNetwork } from './types'

/** Default indexer host (the sluice gateway that fronts etl-api). */
export const DEFAULT_INDEXER_URL = 'https://api.trinary.exchange'

/** The Sui system `Clock` shared object. */
export const CLOCK_ID = '0x6'

/**
 * Canonical on-chain IDs for the `stillness` tenant (testnet world).
 *
 * Source of truth: triex-app-api `src/constants/tenants.ts` → `stillness`, also
 * served (package IDs only) at `GET /api/v1/package-ids?tenant=stillness`.
 * Registry / shared-object IDs are baked here because that endpoint omits them.
 *
 * TODO(config): consider hydrating the *package* IDs at runtime from
 * `/api/v1/package-ids?tenant=stillness` if/when it is routed through the
 * gateway; keep the shared-object IDs baked. See DESIGN.md §8 / RQ-2.
 */
export const STILLNESS_PACKAGE_IDS: PackageIds = {
  triex: '0x291b9da738dffedd18d7c5049e5e6792270202e03f3c9d9db4c7097670bf6eb2',
  triexRegistry:
    '0x14a58f254b8243bf3f74c057d81cc310498b3d0fe3781650ad58405d7e5f17e4',
  multicoin:
    '0x99a4c039477ac7e7affcb5a5609dd23c29ab69e9436e740d94a4e168c2506cfb',
  warehouseReceipts:
    '0x0c9d4414aa12eaa1ebf9d32437c1e6403fbf941ffcdca5b9ca16d1769313417e',
  credCoinType:
    '0xfbcbd9155669e157ce3999e073930b4c4b67255c3cf88d0d80c76342a31e6710::cred::CRED',
  world: '0x8b8a46ed766fa1358ce7c5c51f6a164b13d627a63e45343f69ed0ba0446c1aa1',
  worldOriginal:
    '0x8b8a46ed766fa1358ce7c5c51f6a164b13d627a63e45343f69ed0ba0446c1aa1',
  clock: CLOCK_ID,

  // Armature. `*Original` differs from the current id wherever the package has
  // been upgraded — see the PackageIds doc comment for which id goes where.
  armature:
    '0xee0b501592a5696d2ce284086c054e9e6bc9321e5e468ab4b8bd0ce70570c048',
  armatureOriginal:
    '0xee0b501592a5696d2ce284086c054e9e6bc9321e5e468ab4b8bd0ce70570c048',
  armatureProposals:
    '0x6e5df7cf66e083181bc59d169a59e4f99ff493e9aded6fdabff71978e344f93d',
  armatureProposalsOriginal:
    '0x6e5df7cf66e083181bc59d169a59e4f99ff493e9aded6fdabff71978e344f93d',
  armatureTrading:
    '0xf9ea45362bc1b2b07de91fd5f5fbad952d2ec5a5add3a87816bb76145031defd',
  armatureTradingOriginal:
    '0x0493e8ccbf9477e1b37b0332f3be7abefe4b5fda3731cfe48bf5d6e7fccda1f6',
  armatureVault:
    '0x299e2dce9e586ef1554fe292146cbdeafce894a1d743996e1104e8643d908df8',
  armatureVaultOriginal:
    '0x3af6edb64f575cb65a89f1c8f445a2e2aad05324a1586aad9e2651191bf4f99b',
  armatureWorldBridge:
    '0x0b341844de4bac0dc824f2dd0bc6820c1dee8c7bd83ed23a827d0a859759e087',
  daoReceiptVaultRegistry:
    '0x647c96dd2cd1f84ae441e68b867d9ec48c9be06fd99357a0d3653250e2542623',
}

export const NETWORK_PRESETS: Record<TriexNetwork, PackageIds> = {
  testnet: STILLNESS_PACKAGE_IDS,
}

/**
 * Resolve the effective package IDs for a network, applying per-field overrides.
 */
export function resolvePackageIds(
  network: TriexNetwork = 'testnet',
  overrides?: Partial<PackageIds>,
): PackageIds {
  return { ...NETWORK_PRESETS[network], ...overrides }
}
