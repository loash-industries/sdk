/**
 * Testnet gas top-up: request SUI from the public faucet for SUI_ADDRESS,
 * retrying through rate limits until the balance is non-zero (or ~4h passes).
 *
 *   node --env-file=.env scripts/faucet.mjs
 */
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const recipient = process.env.SUI_ADDRESS
if (!recipient) {
  console.error('SUI_ADDRESS is required (see .env.sample)')
  process.exit(1)
}
const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
})

const balance = async () => {
  const b = await client.getBalance({
    owner: recipient,
    coinType: '0x2::sui::SUI',
  })
  return BigInt(b.balance.balance ?? b.balance.coinBalance ?? 0)
}

for (let attempt = 1; attempt <= 24; attempt++) {
  const bal = await balance()
  if (bal > 0n) {
    console.log(`FUNDED: ${bal} MIST (${attempt - 1} faucet retries)`)
    process.exit(0)
  }
  try {
    await requestSuiFromFaucetV2({ host: getFaucetHost('testnet'), recipient })
    console.log(`attempt ${attempt}: faucet accepted`)
  } catch (e) {
    console.log(`attempt ${attempt}: ${String(e?.message ?? e).slice(0, 80)}`)
  }
  await new Promise((r) => setTimeout(r, 10 * 60 * 1000))
}
console.log('NOT FUNDED after all retries')
process.exit(1)
