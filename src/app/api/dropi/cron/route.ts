import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { syncAllActiveDropiAccounts } from '@/lib/dropi/sync'

/**
 * Sync Dropi orders for every account with dropi_config.is_active =
 * true. Meant to be hit on a schedule (same external-pinger pattern
 * as /api/automations/cron and /api/flows/cron) — shares
 * AUTOMATION_CRON_SECRET so operators only provision one secret.
 *
 * Accounts with is_active = false are never queried — this route
 * touches nothing for an account until that switch is explicitly
 * turned on. Notifications are a second, independent gate checked
 * per-account inside the sync (see src/lib/dropi/sync.ts).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const results = await syncAllActiveDropiAccounts(admin)

  return NextResponse.json({
    accountsSynced: results.length,
    results,
  })
}
