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

/**
 * A signed integer as a decimal string — star-map coordinates in metres.
 *
 * Same reason as `u64`: these run past 2^53 and a JSON number would round
 * them. Unlike `u64` they can be negative, the galactic origin being in the
 * middle of the map rather than at a corner.
 */
export const decimalInt = z
  .string()
  .regex(/^-?\d+$/, 'expected an integer as a decimal string')

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

const limitShape = {
  limit: z.number().int().positive().max(200).optional(),
}

/**
 * Paging comes in two flavours and they are not interchangeable.
 *
 * Discovery is cursor-paged; order history is windowed by timestamp. Offering
 * a `cursor` on a history read is worse than offering no paging at all — the
 * SDK drops the property it does not recognise, so a caller that pages by
 * cursor re-reads page one forever and nothing reports a problem.
 */
export const cursorPagingShape = {
  ...limitShape,
  cursor: z.string().optional(),
}

export const historyPagingShape = {
  ...limitShape,
  before: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Unix ms upper bound, exclusive.'),
  after: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Unix ms lower bound, exclusive.'),
}

/**
 * The location listings declare `limit` as 1–100 in the gateway contract, so
 * they get their own bound rather than borrowing the looser shared one.
 */
export const locationPagingShape = {
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
}

/** Item search takes a limit and nothing else. */
export const searchPagingShape = limitShape

/** Parse a decimal string into a bigint after zod has validated its shape. */
export function big(value: string): bigint {
  return BigInt(value)
}

/** Parse an optional decimal string into an optional bigint. */
export function bigOpt(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value)
}
