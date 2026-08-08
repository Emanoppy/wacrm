// ============================================================
// Dropi order sync — pulls orders from Dropi into the CRM's
// `orders` table and (optionally) notifies the customer by
// WhatsApp when a status changes.
//
// Two independent gates, both must be explicitly turned on by the
// account (see migration 037):
//   - dropi_config.is_active              — sync runs at all
//   - dropi_config.notify_customers_enabled — status changes send WhatsApp
//
// Notifications only fire on a status CHANGE to an order we already
// had, never on the first sync of a brand-new row. Otherwise turning
// this on for the first time would blast a WhatsApp to every
// historical customer at once — exactly the kind of accidental mass
// message an operator would not want.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { listMyOrders, type DropiOrder } from '@/lib/dropi/client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

export interface DropiSyncResult {
  accountId: string
  fetched: number
  upserted: number
  statusChanges: number
  notified: number
  notifyErrors: number
  error?: string
}

function mapDropiOrderToRow(accountId: string, order: DropiOrder) {
  return {
    account_id: accountId,
    dropi_order_id: String(order.id),
    shop_order_id: order.shop_order_id,
    shop_order_number: order.shop_order_number,
    status: order.status,
    customer_name: order.name,
    customer_surname: order.surname,
    customer_phone: order.phone,
    address: order.dir,
    city: order.city,
    state: order.state,
    total_order: order.total_order,
    shipping_amount: order.shipping_amount,
    shipping_company: order.shipping_company,
    distribution_company_id: order.distribution_company_id,
    sticker: order.sticker,
    guide_was_downloaded: order.guide_was_downloaded,
    raw: order,
    last_synced_at: new Date().toISOString(),
  }
}

/**
 * Sync one account's Dropi orders. Safe to call repeatedly — upserts
 * are idempotent on (account_id, dropi_order_id).
 */
export async function syncAccountDropiOrders(
  db: SupabaseClient,
  accountId: string
): Promise<DropiSyncResult> {
  const result: DropiSyncResult = {
    accountId,
    fetched: 0,
    upserted: 0,
    statusChanges: 0,
    notified: 0,
    notifyErrors: 0,
  }

  const { data: config } = await db
    .from('dropi_config')
    .select(
      'integration_key, is_active, notify_customers_enabled, notify_template_name'
    )
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config || !config.is_active) {
    return result // sync is off — do nothing, not even a read
  }

  // Atomic claim: if another sync for this account is already running
  // (the cron and a manual "Sync now" click landing at the same
  // moment), this returns false and we exit without doing any work —
  // prevents both from reading the same pre-change status and each
  // firing a duplicate customer notification. See migration 038.
  const { data: claimed } = await db.rpc('claim_dropi_sync', {
    p_account_id: accountId,
  })
  if (!claimed) return result

  try {
    const integrationKey = decrypt(config.integration_key as string)

    let orders: DropiOrder[]
    try {
      orders = await listMyOrders({ integrationKey, resultNumber: 50 })
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'unknown Dropi API error'
      console.error(`[dropi/sync] listMyOrders failed for account ${accountId}:`, result.error)
      return result
    }
    result.fetched = orders.length

    for (const order of orders) {
      await upsertOneOrder(db, accountId, order, result, {
        notifyEnabled: config.notify_customers_enabled,
        notifyTemplateName: config.notify_template_name,
      })
    }

    return result
  } finally {
    // Always release, success or failure — an uncaught throw must not
    // leave the account permanently locked out of future syncs.
    await db
      .from('dropi_config')
      .update({ last_synced_at: new Date().toISOString(), syncing: false })
      .eq('account_id', accountId)
  }
}

/**
 * Shared upsert step for a single Dropi order — used by both the
 * regular (last-50) sync and the full backfill below. `notifyEnabled`
 * is passed explicitly (rather than re-read from config) so the
 * backfill can force it off unconditionally regardless of the
 * account's saved setting — see backfillAccountDropiOrders.
 */
async function upsertOneOrder(
  db: SupabaseClient,
  accountId: string,
  order: DropiOrder,
  result: DropiSyncResult,
  notify: { notifyEnabled: boolean; notifyTemplateName: string | null }
): Promise<void> {
  const dropiOrderId = String(order.id)

  const { data: existing } = await db
    .from('orders')
    .select('id, status, contact_id, conversation_id')
    .eq('account_id', accountId)
    .eq('dropi_order_id', dropiOrderId)
    .maybeSingle()

  const row = mapDropiOrderToRow(accountId, order)
  const statusChanged = Boolean(existing) && existing!.status !== order.status

  const { data: upserted, error: upsertError } = await db
    .from('orders')
    .upsert(row, { onConflict: 'account_id,dropi_order_id' })
    .select('id, contact_id, conversation_id')
    .single()

  if (upsertError || !upserted) return
  result.upserted++

  let statusEventId: string | null = null
  if (existing && statusChanged) {
    result.statusChanges++
    const { data: event } = await db
      .from('order_status_events')
      .insert({
        order_id: upserted.id,
        account_id: accountId,
        from_status: existing.status,
        to_status: order.status,
        customer_notified: false,
      })
      .select('id')
      .single()
    statusEventId = event?.id ?? null
  }

  // Notifications: only on a genuine status change to a pre-existing
  // order, and only if both gates are on (the backfill call site
  // passes notifyEnabled: false unconditionally).
  if (
    existing &&
    statusChanged &&
    notify.notifyEnabled &&
    notify.notifyTemplateName &&
    order.phone
  ) {
    try {
      const conversation = await resolveConversationByPhone(
        db,
        accountId,
        order.phone,
        order.name
      )
      await sendMessageToConversation(db, accountId, {
        conversationId: conversation.conversationId,
        messageType: 'template',
        templateName: notify.notifyTemplateName,
        templateLanguage: 'es',
        templateParams: [order.status],
      })
      result.notified++
      // Update the exact event row this send corresponds to — matching
      // by (order_id, to_status) instead would also touch any earlier
      // event for the same order+status whose send actually failed,
      // mislabeling it as notified in the audit trail.
      if (statusEventId) {
        await db
          .from('order_status_events')
          .update({ customer_notified: true })
          .eq('id', statusEventId)
      }
    } catch {
      // Best-effort: a bad phone, no WhatsApp configured, or a send
      // failure must never break the sync for other orders.
      result.notifyErrors++
    }
  }
}

const BACKFILL_PAGE_SIZE = 100
// Hard ceiling so a runaway account (or an API that never returns a
// short page) can't turn one click into an unbounded loop against a
// live, real Dropi account. 200 pages * 100 = 20,000 orders — well
// past what a solo dropshipper would have; raise this later if a real
// account legitimately needs more.
const BACKFILL_MAX_PAGES = 200

/**
 * One-time (or occasional) full history import — paginates through
 * EVERY order Dropi has for this account, not just the most recent
 * batch. Reuses the same upsert as the regular sync, but with
 * notifications forced OFF regardless of dropi_config — importing
 * history must never be mistaken for a live status change and blast
 * WhatsApp messages to a customer from three months ago.
 *
 * Meant to be triggered manually (a separate, explicit "Import full
 * history" action) — NOT wired into the recurring cron, since it can
 * be a much heavier call against a live account than the routine
 * last-50 check.
 */
export async function backfillAccountDropiOrders(
  db: SupabaseClient,
  accountId: string
): Promise<DropiSyncResult> {
  const result: DropiSyncResult = {
    accountId,
    fetched: 0,
    upserted: 0,
    statusChanges: 0,
    notified: 0,
    notifyErrors: 0,
  }

  const { data: config } = await db
    .from('dropi_config')
    .select('integration_key, is_active')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config || !config.is_active) {
    return result
  }

  // Same account-level lock as the routine sync — a backfill and a
  // cron tick (or two backfill clicks) must not overlap. See
  // migration 038.
  const { data: claimed } = await db.rpc('claim_dropi_sync', {
    p_account_id: accountId,
  })
  if (!claimed) return result

  try {
    const integrationKey = decrypt(config.integration_key as string)

    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      let orders: DropiOrder[]
      try {
        orders = await listMyOrders({
          integrationKey,
          resultNumber: BACKFILL_PAGE_SIZE,
          start: page * BACKFILL_PAGE_SIZE,
        })
      } catch (err) {
        result.error = err instanceof Error ? err.message : 'unknown Dropi API error'
        console.error(
          `[dropi/backfill] listMyOrders failed for account ${accountId} at page ${page}:`,
          result.error
        )
        break
      }

      if (orders.length === 0) break
      result.fetched += orders.length

      for (const order of orders) {
        await upsertOneOrder(db, accountId, order, result, {
          notifyEnabled: false,
          notifyTemplateName: null,
        })
      }

      if (orders.length < BACKFILL_PAGE_SIZE) break // last page
    }

    return result
  } finally {
    await db
      .from('dropi_config')
      .update({ last_synced_at: new Date().toISOString(), syncing: false })
      .eq('account_id', accountId)
  }
}

/**
 * Sync every account that has Dropi sync turned on. Meant to be
 * called from the cron route — mirrors the batch shape of
 * /api/automations/cron.
 */
export async function syncAllActiveDropiAccounts(
  db: SupabaseClient
): Promise<DropiSyncResult[]> {
  const { data: accounts } = await db
    .from('dropi_config')
    .select('account_id')
    .eq('is_active', true)

  if (!accounts || accounts.length === 0) return []

  const results: DropiSyncResult[] = []
  for (const { account_id } of accounts) {
    results.push(await syncAccountDropiOrders(db, account_id as string))
  }
  return results
}
