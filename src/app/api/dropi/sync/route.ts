import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { syncAccountDropiOrders } from '@/lib/dropi/sync'

/**
 * Manual "Sync now" button on the Orders page. Same underlying sync
 * as the cron route, scoped to the caller's own account.
 *
 * requireRole('agent') is the authorization boundary — it confirms
 * the caller belongs to THIS account with agent+ role. Past that
 * check, the sync itself runs under the service-role client (not the
 * caller's RLS-bound one): it needs to insert into
 * `order_status_events` and update `dropi_config.last_synced_at`,
 * which are intentionally service-role-only writes (mirrors
 * automation_logs / the webhook's use of supabaseAdmin — see
 * src/lib/automations/engine.ts). `accountId` comes from the already-
 * verified session, never from the request body, so this can't be
 * used to sync another account's orders.
 *
 * Still respects dropi_config.is_active: if the account hasn't
 * turned Dropi sync on, this is a no-op (see syncAccountDropiOrders).
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('agent')
    const admin = supabaseAdmin()
    const result = await syncAccountDropiOrders(admin, accountId)
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
