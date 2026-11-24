import { TriexClientError, TriexError } from './errors'
import type { PackageIds } from './types'

/**
 * The app's package-id endpoint: public, no API key, cached for 60 s. It is
 * the same source of truth the baked preset is copied from (triex-app-api
 * `tenants.ts`), served live — so an upgrade reaches clients without an SDK
 * release.
 */
export const PACKAGE_IDS_URL = 'https://trinary.exchange/api/v1/package-ids'

/** Upgradeable packages: the current id (moveCall target) and its original. */
const UPGRADEABLE: Array<{
  field: keyof PackageIds
  original: keyof PackageIds
  wire: string
  wireOriginal: string
}> = [
  {
    field: 'triex',
    original: 'triexOriginal',
    wire: 'triexPackageId',
    wireOriginal: 'triexPackageIdOriginal',
  },
  {
    field: 'warehouseReceipts',
    original: 'warehouseReceiptsOriginal',
    wire: 'warehouseReceiptsPackageId',
    wireOriginal: 'warehouseReceiptsPackageIdOriginal',
  },
  {
    field: 'world',
    original: 'worldOriginal',
    wire: 'worldPackageId',
    wireOriginal: 'worldOriginalPackageId',
  },
  {
    field: 'armature',
    original: 'armatureOriginal',
    wire: 'armaturePackageId',
    wireOriginal: 'armaturePackageIdOriginal',
  },
  {
    field: 'armatureProposals',
    original: 'armatureProposalsOriginal',
    wire: 'armatureProposalsPackageId',
    wireOriginal: 'armatureProposalsPackageIdOriginal',
  },
  {
    field: 'armatureTrading',
    original: 'armatureTradingOriginal',
    wire: 'armatureTradingPackageId',
    wireOriginal: 'armatureTradingPackageIdOriginal',
  },
  {
    field: 'armatureVault',
    original: 'armatureVaultOriginal',
    wire: 'armatureVaultPackageId',
    wireOriginal: 'armatureVaultPackageIdOriginal',
  },
]

const HEX_ID = /^0x[0-9a-fA-F]{1,64}$/

const norm = (id: string) => '0x' + id.slice(2).toLowerCase().padStart(64, '0')

/** One package as the endpoint reports it. */
export interface LivePackageId {
  field: keyof PackageIds
  current: string
  original: string
}

/**
 * Fetch the live package ids for a tenant (default `stillness`).
 * @throws `IndexerError` when the endpoint can't be reached or answers badly.
 */
export async function fetchLivePackageIds(opts?: {
  tenant?: string
  url?: string
}): Promise<LivePackageId[]> {
  const url = new URL(opts?.url ?? PACKAGE_IDS_URL)
  url.searchParams.set('tenant', opts?.tenant ?? 'stillness')
  let body: Record<string, unknown>
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = (await res.json()) as Record<string, unknown>
  } catch (e) {
    throw new TriexClientError(
      TriexError.IndexerError,
      `Could not load live package ids from ${url.origin}${url.pathname}: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }
  const out: LivePackageId[] = []
  for (const p of UPGRADEABLE) {
    const current = body?.[p.wire]
    const original = body?.[p.wireOriginal] ?? current
    if (
      typeof current === 'string' &&
      HEX_ID.test(current) &&
      typeof original === 'string' &&
      HEX_ID.test(original)
    ) {
      out.push({ field: p.field, current, original })
    }
  }
  return out
}

/** What a refresh changed, kept and refused. */
export interface PackageIdRefresh {
  /** Move-call targets moved to a newer version of the same package. */
  applied: Array<{ field: keyof PackageIds; from: string; to: string }>
  /**
   * Packages the endpoint reports from a different lineage (another original
   * id: a cycle rollover, which also replaces shared objects) or that the
   * caller pinned with an override. Left as they were.
   */
  skipped: Array<{ field: keyof PackageIds; reason: string }>
}

/**
 * Move the client's `moveCall` targets to the live versions, in place.
 *
 * Only an UPGRADE is applied: the fetched package must have the same original
 * id as the one configured, so type tags, shared objects and the original ids
 * stay exactly as they were. A different original means a new cycle (fresh
 * publishes with new shared objects), which needs an SDK release.
 */
export function applyLivePackageIds(
  ids: PackageIds,
  live: LivePackageId[],
  pinned: ReadonlySet<string> = new Set(),
): PackageIdRefresh {
  const report: PackageIdRefresh = { applied: [], skipped: [] }
  for (const p of live) {
    const spec = UPGRADEABLE.find((u) => u.field === p.field)!
    const configuredOriginal = ids[spec.original] as string | undefined
    const configured = ids[p.field] as string | undefined
    if (pinned.has(p.field)) {
      report.skipped.push({ field: p.field, reason: 'pinned by an override' })
      continue
    }
    if (!configuredOriginal || norm(configuredOriginal) !== norm(p.original)) {
      report.skipped.push({
        field: p.field,
        reason: `different original id (${p.original}): a new deployment, not an upgrade — update the SDK`,
      })
      continue
    }
    if (configured && norm(configured) === norm(p.current)) continue
    ;(ids as unknown as Record<string, string>)[p.field] = p.current
    report.applied.push({
      field: p.field,
      from: configured ?? '',
      to: p.current,
    })
  }
  return report
}
