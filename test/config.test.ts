import { STILLNESS_PACKAGE_IDS, resolvePackageIds } from '../src/config'

/**
 * Pins the testnet preset to the cycle-7 deployment (triex published at
 * 0xa9df…, `testnet_stillness`). A wrong id here fails every write, so a
 * redeploy has to update this test on purpose.
 */
describe('testnet preset (cycle 7)', () => {
  it('points at the cycle-7 triex package and shared objects', () => {
    expect(STILLNESS_PACKAGE_IDS).toMatchObject({
      triex:
        '0xa9dfa639b89afcec3a206398510f2a3dee80478a765d238a2d33b58d14bdc8b4',
      triexRegistry:
        '0xc777162427090072d3034565544f285131ae6a23909dd237d51677504d65469b',
      triexFeePolicy:
        '0x3285b29bb35ed4feae7b921413122e2f82a809e8a398216b47d9915531e24551',
      multicoin:
        '0xdbb778cba30e7deccf61169fbfbcd10a867654e1e2822facd789a99bd2c4e2ba',
      warehouseReceipts:
        '0x134dfa96ad8bc50d4a2055cd78c91e264feb2fe79facf2d030f8bb466a80bb68',
      world:
        '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
      worldOriginal:
        '0x7be18d6294e533bedd9a5d70a96ce8d9d4b87a7c74188ba65d3fe966bbed9d92',
      clock: '0x6',
    })
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
