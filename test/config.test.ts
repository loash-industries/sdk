import { STILLNESS_PACKAGE_IDS, resolvePackageIds } from '../src/config'

/**
 * Pins the testnet preset to the cycle-7 deployment (`testnet_stillness`) as
 * it stands after the 2026-10 upgrades, every id taken from triex-app-api's
 * `tenants.ts` and each package's `Published.toml`. A wrong id here fails every
 * write, so a redeploy or upgrade has to update this test on purpose.
 */
describe('testnet preset (cycle 7)', () => {
  it('points at the cycle-7 triex package and shared objects', () => {
    expect(STILLNESS_PACKAGE_IDS).toMatchObject({
      // v3 (2026-10-05); the original id stays the cycle-7 publish.
      triex:
        '0x57f5fded64aebd46a202dceccf66f41aa912a28f7de395a4db1d8b60052e442c',
      triexOriginal:
        '0xdbf259ed33d70666379492199137e2ad50fcc1ed1e56acd5780329f7fe982945',
      triexRegistry:
        '0x2f37ad133427cabf94653be9a67560f87ea7458eaef2b410f6497808cef722c2',
      triexFeePolicy:
        '0xcd63402799fe6b3a3ff2d963f90449e843f178659c349a08a1503db516163748',
      multicoin:
        '0xdbb778cba30e7deccf61169fbfbcd10a867654e1e2822facd789a99bd2c4e2ba',
      // v2 (2026-10-04).
      warehouseReceipts:
        '0xcfd8ce37426e9ed1578795f538e8e5c6a5275d509c651d96586dfb877998194c',
      warehouseReceiptsOriginal:
        '0x134dfa96ad8bc50d4a2055cd78c91e264feb2fe79facf2d030f8bb466a80bb68',
      triexHubOperatorAdapter:
        '0x658ee39f76e5c5be53f54cd5923e2409c9fadad0e813d3a5f74278f9311fcf75',
      world:
        '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
      worldOriginal:
        '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
      clock: '0x6',
    })
  })

  it('points at the cycle-7 Armature packages and vault registry', () => {
    expect(STILLNESS_PACKAGE_IDS).toMatchObject({
      armature:
        '0x0a9eee47251a9f8a264a18804b1d5e553514720c4f4f765a481d1f12b492624c',
      armatureProposals:
        '0x19ccd64e194ed97a07c929459be44a06357f2eeef774d2800626f51d7ed0b599',
      armatureVault:
        '0xf447556abd7a92cc8690d626e1dd85dd40510c4a4dd75dcb5671f88ddfaec87e',
      // v2 (2026-10-04, re-linked against triex v2).
      armatureTrading:
        '0x602c62157021799a57827f580f100708062f9bcb7dd273ea34e9f6880689cb52',
      armatureTradingOriginal:
        '0xe7060901772310333cfe7ca055ce5bb06a067e4209b5db3fe684ac3e6b2a0fce',
      ouReceiptVaultRegistry:
        '0x1013b7921bae7623ec066ae9d328cad2e72c47b3325239e93b20c45156794ddf',
    })
  })

  it('splits current and original ids exactly where a package was upgraded', () => {
    const ids = STILLNESS_PACKAGE_IDS
    // Upgraded since the cycle-7 publish: calls and type tags differ.
    expect(ids.triexOriginal).not.toBe(ids.triex)
    expect(ids.armatureTradingOriginal).not.toBe(ids.armatureTrading)
    expect(ids.warehouseReceiptsOriginal).not.toBe(ids.warehouseReceipts)
    // Never upgraded: still equal.
    expect(ids.worldOriginal).toBe(ids.world)
    expect(ids.armatureOriginal).toBe(ids.armature)
    expect(ids.armatureProposalsOriginal).toBe(ids.armatureProposals)
    expect(ids.armatureVaultOriginal).toBe(ids.armatureVault)
  })

  it('keeps the CRED coin type, which is never republished', () => {
    expect(STILLNESS_PACKAGE_IDS.credCoinType).toBe(
      '0xfbcbd9155669e157ce3999e073930b4c4b67255c3cf88d0d80c76342a31e6710::cred::CRED',
    )
  })

  it('lets callers override the FeePolicy id', () => {
    expect(
      resolvePackageIds('testnet', { triexFeePolicy: '0xfee' }).triexFeePolicy,
    ).toBe('0xfee')
  })
})
