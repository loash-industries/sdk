import { TriexClientError, TriexError } from './errors'

/**
 * Which API gateway the SDK's reads go to.
 *
 * - `triex` (default): `https://api.trinary.exchange`, with a Trinary Exchange
 *   key. Paths are `/v1/…`.
 * - `voidwire`: `https://api.voidwire.xyz`, with a Voidwire key (`sk_vw_…`).
 *   Same data, but every path sits under a product group: `/{group}/v1/…`.
 *
 * Keys are not shared between the two.
 */
export type TriexGateway = 'triex' | 'voidwire'

/** Base URL of each gateway. */
export const GATEWAY_URLS: Readonly<Record<TriexGateway, string>> = {
  triex: 'https://api.trinary.exchange',
  voidwire: 'https://api.voidwire.xyz',
}

/**
 * Voidwire's group for a `/v1/…` path, first match wins. The specific rows come
 * first: an organization's or
 * player's agreements are `hauling`, and a hub item's book is `trading`.
 * `test/voidwire.test.ts` checks every SDK call site against Voidwire's
 * published contract, so a new read that lands in the wrong group fails there.
 */
const VOIDWIRE_GROUPS: readonly (readonly [RegExp, string])[] = [
  [/^\/v1\/(orgs|players)\/[^/]+\/agreements(\/|$)/, 'hauling'],
  [/^\/v1\/players\/[^/]+\/(accessible-keyspaces|orgs)$/, 'orgs'],
  [/^\/v1\/hubs\/[^/]+\/items\/[^/]+\/orderbook$/, 'trading'],
  [/^\/v1\/agreements(\/|$)/, 'hauling'],
  [/^\/v1\/(assemblies|collections|hubs|inventory|items)(\/|$)/, 'hubs'],
  [/^\/v1\/characters(\/|$)/, 'characters'],
  [
    /^\/v1\/(coins|display-prices|fills|pools|trades|trading-accounts)(\/|$)/,
    'trading',
  ],
  [/^\/v1\/(discovery|search|stats)(\/|$)/, 'explore'],
  [/^\/v1\/orgs(\/|$)/, 'orgs'],
  [/^\/v1\/(routing|solar-systems|spatial)(\/|$)/, 'map'],
  [/^\/v1\/world(\/|$)/, 'world'],
]

/**
 * The path to request on `gateway` for the SDK's canonical `/v1/…` path.
 * Throws `NotOnGateway` for a read that gateway does not serve, so the caller
 * gets the reason instead of a bare 404.
 */
export function gatewayPath(gateway: TriexGateway, path: string): string {
  if (gateway === 'triex') return path
  const group = VOIDWIRE_GROUPS.find(([pattern]) => pattern.test(path))?.[1]
  if (!group) {
    throw new TriexClientError(
      TriexError.NotOnGateway,
      `Voidwire does not serve ${path}. Use the default gateway ('triex') with a Trinary Exchange key for this read.`,
    )
  }
  return `/${group}${path}`
}
