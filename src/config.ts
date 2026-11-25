import { GATEWAY_URLS } from './gateways'
import type { PackageIds, TriexNetwork } from './types'

/** Default indexer host (the sluice gateway that fronts etl-api). */
export const DEFAULT_INDEXER_URL = GATEWAY_URLS.triex

/** The Sui system `Clock` shared object. */
export const CLOCK_ID = '0x6'

/**
 * Canonical on-chain IDs for the `stillness` tenant (testnet world), cycle 7.
 *
 * Source of truth: triex-app-api `src/constants/tenants.ts` → `stillness`, also
 * served (package IDs only) at `GET /api/v1/package-ids?tenant=stillness`.
 * Registry / shared-object IDs are baked here because that endpoint omits them.
 *
 * Package upgrades reach clients without an SDK release through
 * `TriexClient.connect()` / `client.refreshPackageIds()` (livePackageIds.ts),
 * which read the app's public `/api/v1/package-ids`. Shared objects and
 * original ids stay baked.
 */
export const STILLNESS_PACKAGE_IDS: PackageIds = {
  // Upgraded since the cycle-7 publish, so `moveCall` targets (the current
  // id) and type tags (`*Original`) differ for: triex (v3, 2026-10-05: operator
  // share claims pay into address balances; v2 added fold_pending_turnover),
  // warehouse_receipts (v2, 2026-10-04: receipt::new_vault / PendingVault) and
  // armature_trading (v2, re-linked against triex v2).
  triex: '0x57f5fded64aebd46a202dceccf66f41aa912a28f7de395a4db1d8b60052e442c',
  triexOriginal:
    '0xdbf259ed33d70666379492199137e2ad50fcc1ed1e56acd5780329f7fe982945',
  triexRegistry:
    '0x2f37ad133427cabf94653be9a67560f87ea7458eaef2b410f6497808cef722c2',
  triexFeePolicy:
    '0xcd63402799fe6b3a3ff2d963f90449e843f178659c349a08a1503db516163748',
  multicoin:
    '0xdbb778cba30e7deccf61169fbfbcd10a867654e1e2822facd789a99bd2c4e2ba',
  warehouseReceipts:
    '0xcfd8ce37426e9ed1578795f538e8e5c6a5275d509c651d96586dfb877998194c',
  warehouseReceiptsOriginal:
    '0x134dfa96ad8bc50d4a2055cd78c91e264feb2fe79facf2d030f8bb466a80bb68',
  // Registers / rotates a storage unit's hub-share payout address.
  triexHubOperatorAdapter:
    '0x658ee39f76e5c5be53f54cd5923e2409c9fadad0e813d3a5f74278f9311fcf75',
  // The CRED token package is never republished; it carries over every cycle.
  credCoinType:
    '0xfbcbd9155669e157ce3999e073930b4c4b67255c3cf88d0d80c76342a31e6710::cred::CRED',
  world: '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
  worldOriginal:
    '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
  clock: CLOCK_ID,

  // Armature — cycle 7 publishes (armature/armature-vault/armature-trading
  // `Published.toml` → `testnet_stillness`). Only armature_trading has been
  // upgraded since, so it is the one pair whose ids differ.
  armature:
    '0x0a9eee47251a9f8a264a18804b1d5e553514720c4f4f765a481d1f12b492624c',
  armatureOriginal:
    '0x0a9eee47251a9f8a264a18804b1d5e553514720c4f4f765a481d1f12b492624c',
  armatureProposals:
    '0x19ccd64e194ed97a07c929459be44a06357f2eeef774d2800626f51d7ed0b599',
  armatureProposalsOriginal:
    '0x19ccd64e194ed97a07c929459be44a06357f2eeef774d2800626f51d7ed0b599',
  armatureTrading:
    '0x602c62157021799a57827f580f100708062f9bcb7dd273ea34e9f6880689cb52',
  armatureTradingOriginal:
    '0xe7060901772310333cfe7ca055ce5bb06a067e4209b5db3fe684ac3e6b2a0fce',
  armatureVault:
    '0xf447556abd7a92cc8690d626e1dd85dd40510c4a4dd75dcb5671f88ddfaec87e',
  armatureVaultOriginal:
    '0xf447556abd7a92cc8690d626e1dd85dd40510c4a4dd75dcb5671f88ddfaec87e',
  ouReceiptVaultRegistry:
    '0x1013b7921bae7623ec066ae9d328cad2e72c47b3325239e93b20c45156794ddf',

  // Hauling agreements — armature-vault PR #24, published 2026-10-26
  // (triex-app-api tenants.ts → stillness). `agreements` was upgraded to v2;
  // its types keep the original id.
  haulingAgreements:
    '0xc994255f765235db14e1edde543682ee1de1590357111cf4fe279d7eed1a6a06',
  haulingConfig:
    '0x53f55e40d88e8644f9064deb8de40ed565ff2a7c6ea15d2f4379666a87b6d510',
  agreements:
    '0x5cd30eec41c53850d005549d51cb28cde59caf6761d20e58d5733ee31466c6c7',
  agreementsOriginal:
    '0x74ec0fcf8aa5a701245d1dff0f541208b072d991c4348c1a4c7e24fcf55135df',
  roles: '0xb918d3691ba22a30b5adc87fe37c9012c8de66446b426f96d1da89aec42bbb43',
  agreementRoles:
    '0x4d03af5b86a7ad762fb85d3a9189e6e5e640eec082f086ec2c436b964f063b6b',
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
