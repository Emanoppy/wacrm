import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { backfillAccountDropiOrders } from '@/lib/dropi/sync'

/**
 * "Import full history" button on the Orders page — paginates through
 * every order Dropi has (not just the most recent batch the routine
 * sync checks). Same auth/service-role shape as /api/dropi/sync; see
 * that route's comment for why requireRole + supabaseAdmin is the
 * pattern here rather than the caller's RLS-bound client.
 *
 * Notifications are hard-disabled inside backfillAccountDropiOrders
 * regardless of dropi_config — this endpoint can never message a
 * customer, by design.
 */
export async function POST() {
  try {
    const { accountId } = await requireRole('agent')
    const admin = supabaseAdmin()
    const result = await backfillAccountDropiOrders(admin, accountId)
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
