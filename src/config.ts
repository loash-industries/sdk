import type { PackageIds, TriexNetwork } from './types'

/** Default indexer host (the sluice gateway that fronts etl-api). */
export const DEFAULT_INDEXER_URL = 'https://api.trinary.exchange'

/** The Sui system `Clock` shared object. */
export const CLOCK_ID = '0x6'

/**
 * Canonical on-chain IDs for the `stillness` tenant (testnet world), cycle 7.
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
  triex: '0xdbf259ed33d70666379492199137e2ad50fcc1ed1e56acd5780329f7fe982945',
  triexRegistry:
    '0x2f37ad133427cabf94653be9a67560f87ea7458eaef2b410f6497808cef722c2',
  triexFeePolicy:
    '0xcd63402799fe6b3a3ff2d963f90449e843f178659c349a08a1503db516163748',
  multicoin:
    '0xdbb778cba30e7deccf61169fbfbcd10a867654e1e2822facd789a99bd2c4e2ba',
  warehouseReceipts:
    '0x134dfa96ad8bc50d4a2055cd78c91e264feb2fe79facf2d030f8bb466a80bb68',
  // The CRED token package is never republished; it carries over every cycle.
  credCoinType:
    '0xfbcbd9155669e157ce3999e073930b4c4b67255c3cf88d0d80c76342a31e6710::cred::CRED',
  world: '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
  worldOriginal:
    '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
  clock: CLOCK_ID,
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
