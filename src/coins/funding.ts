import type { ClientWithCoreApi } from '@mysten/sui/client'
import type {
  Transaction,
  TransactionObjectArgument,
} from '@mysten/sui/transactions'
import { normalizeStructTag } from '@mysten/sui/utils'

import { TriexClientError, TriexError } from '../errors'
import { prepareWalletCoinInput } from '../funding'
import { getWalletCurrencyBalance } from '../onchain'
import { depositCoin } from '../transactions'
import type { PackageIds } from '../types'
import { getTradingAccountCoinBalance } from './onchain'

const SUI_TYPE = normalizeStructTag('0x2::sui::SUI')

/** True when `coinType` is SUI — the gas coin, which needs `tx.gas`. */
export function isSuiCoinType(coinType: string): boolean {
  try {
    return normalizeStructTag(coinType) === SUI_TYPE
  } catch {
    return false
  }
}

/**
 * Split `amount` of any coin type out of the owner's wallet. Non-SUI coins
 * are merged + split like CRED (`prepareWalletCoinInput`); SUI is split from
 * the gas coin, because selecting SUI coin objects as inputs would collide
 * with the wallet's gas selection. Throws `InsufficientBalance` up front.
 */
export async function prepareCoinInput(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  owner: string,
  coinType: string,
  amount: bigint,
  insufficientMessage?: string,
): Promise<TransactionObjectArgument> {
  const label = coinType.split('::').pop() ?? 'coin'
  const message =
    insufficientMessage ??
    `Insufficient ${label} in the wallet for this transaction.`
  if (isSuiCoinType(coinType)) {
    const total = await getWalletCurrencyBalance(suiClient, owner, coinType)
    if (total < amount) {
      throw new TriexClientError(
        TriexError.InsufficientBalance,
        `${message} (need ${amount}, wallet holds ${total}; gas is paid from the same balance).`,
      )
    }
    const [split] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)])
    return split
  }
  return prepareWalletCoinInput(suiClient, tx, owner, coinType, amount, message)
}

/**
 * Ensure the trading account holds at least `target` of `coinType`, pulling
 * only the deficit from the wallet (account balance consumed first — the
 * app's `depositDeficitToBm`). `existingAccountId` is null when the account is
 * being created in this same PTB (balance 0). Returns the amount deposited.
 */
export async function depositCoinDeficit(
  suiClient: ClientWithCoreApi,
  tx: Transaction,
  ids: PackageIds,
  account: TransactionObjectArgument,
  existingAccountId: string | null,
  owner: string,
  coinType: string,
  target: bigint,
): Promise<bigint> {
  const held = existingAccountId
    ? await getTradingAccountCoinBalance(
        suiClient,
        ids,
        existingAccountId,
        coinType,
      )
    : 0n
  const deficit = target > held ? target - held : 0n
  if (deficit === 0n) return 0n
  const label = coinType.split('::').pop() ?? 'coin'
  const coin = await prepareCoinInput(
    suiClient,
    tx,
    owner,
    coinType,
    deficit,
    `Insufficient ${label} to fund the trading account for this order.`,
  )
  depositCoin(tx, ids, account, coin, coinType)
  return deficit
}
