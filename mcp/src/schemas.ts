import { z } from 'zod'

/**
 * Input primitives for tool schemas.
 *
 * u64-ish values cross the MCP boundary as decimal strings — JSON has no
 * bigint, and silently truncating an order price through a double is not an
 * acceptable failure mode. This mirrors the relay-api convention.
 */
export const u64 = z
  .string()
  .regex(/^\d+$/, 'expected a non-negative integer as a decimal string')

export const suiAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/, 'expected a 0x-prefixed Sui address')

export const objectId = suiAddress

export const orderSide = z.enum(['buy', 'sell'])

/** The address a prepared transaction is built for. Only its key can sign. */
export const senderShape = {
  sender: suiAddress.describe(
    'Sui address the transaction is built for; only this address can sign the result.',
  ),
}

export const hubAssetShape = {
  storageUnitId: objectId.describe('Trade hub / storage unit object id.'),
  assetId: z.string().describe('EVE Frontier item asset id, e.g. "70810".'),
}

export const pagingShape = {
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
}

/** Parse a decimal string into a bigint after zod has validated its shape. */
export function big(value: string): bigint {
  return BigInt(value)
}

/** Parse an optional decimal string into an optional bigint. */
export function bigOpt(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value)
}
