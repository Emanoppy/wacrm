// ============================================================
// Dropi order sync — pulls orders from Dropi into the CRM's
// `orders` table and (optionally) fires the `order_status_changed`
// automation trigger when a status changes.
//
// Two independent gates, both must be explicitly turned on by the
// account (see migrations 037 + 041):
//   - dropi_config.is_active              — sync runs at all
//   - dropi_config.notify_customers_enabled — status changes dispatch
//     the order_status_changed automation trigger
//
// A third, per-status gate: dropi_config.never_notify_statuses lists
// statuses (e.g. CANCELADO) that must never dispatch the trigger even
// when notifications are on — a cancelled order isn't a "keep the
// customer informed" moment.
//
// Notifications only fire on a status CHANGE to an order we already
// had, never on the first sync of a brand-new row. Otherwise turning
// this on for the first time would blast a message to every
// historical customer at once — exactly the kind of accidental mass
// message an operator would not want.
//
// Phase 1 change (see ROADMAP.md): the actual message send used to be
// a single hardcoded WhatsApp template (`notify_template_name`). It's
// now dispatched through the Automations engine as the
// `order_status_changed` trigger, so each status transition can have
// its own automation/template configured from the no-code builder
// instead of one global field.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { listMyOrders, getOrderById, type DropiOrder } from '@/lib/dropi/client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'

export interface DropiSyncResult {
  accountId: string
  fetched: number
  upserted: number
  statusChanges: number
  notified: number
  notifyErrors: number
  /** True when `fetched === sync_batch_size` — there may be more
   *  orders than this run pulled; the account may want to raise its
   *  batch size (Settings → Dropi). */
  mayHaveMore?: boolean
  /** New deals created in the linked pipeline (ROADMAP.md Fase 5). */
  dealsCreated: number
  /** Existing deals moved to a new stage. */
  dealsMoved: number
  /** New contact↔niche-tag links created (ROADMAP.md Fase 6) — counts
   *  only tags that were actually new, not repeat no-ops. */
  contactsTagged: number
  error?: string
}

/** Which pipeline/stage a status maps to, resolved once per sync run
 *  (not per order) — see syncAccountDropiOrders. Null when the
 *  account hasn't linked a pipeline (Settings → Dropi). */
interface PipelineSync {
  pipelineId: string
  statusStageMap: Record<string, string>
  defaultCurrency: string
}

const DEFAULT_BATCH_SIZE = 50

function mapDropiOrderToRow(
  accountId: string,
  order: DropiOrder,
  contactId: string | null,
  conversationId: string | null,
) {
  return {
    account_id: accountId,
    contact_id: contactId,
    conversation_id: conversationId,
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
    dropi_created_at: order.created_at || null,
    raw: order,
    last_synced_at: new Date().toISOString(),
  }
}

/**
 * Resolve (and, where possible, create) the contact + conversation for
 * an order's phone number — same de-dupe convention as the WhatsApp
 * webhook (`findExistingContact`), so a contact created from a Dropi
 * order is indistinguishable from one created any other way.
 *
 * `resolveConversationByPhone` is tried first since it handles both in
 * one call, but it requires WhatsApp to be configured (it throws
 * before touching anything otherwise). Dropi sync must keep working
 * for accounts that haven't connected WhatsApp yet, so on any failure
 * this falls back to a contact-only resolution — the order still gets
 * linked to a customer record, just without a conversation.
 */
async function resolveOrderContact(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  name: string | null,
): Promise<{ contactId: string | null; conversationId: string | null }> {
  if (!phone) return { contactId: null, conversationId: null }

  try {
    const resolved = await resolveConversationByPhone(db, accountId, phone, name)
    return { contactId: resolved.contactId, conversationId: resolved.conversationId }
  } catch {
    // WhatsApp not configured, a malformed phone, or a transient DB
    // error — fall back to a contact-only resolution rather than
    // leaving the order completely unlinked.
  }

  const existing = await findExistingContact(db, accountId, phone)
  if (existing) return { contactId: existing.id, conversationId: null }

  let ownerUserId: string
  try {
    ownerUserId = await resolveAuditUserId(db, accountId)
  } catch (err) {
    if (err instanceof ContactError) return { contactId: null, conversationId: null }
    throw err
  }

  const { data: created, error: createErr } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select('id')
    .single()

  if (created) return { contactId: created.id, conversationId: null }
  if (isUniqueViolation(createErr)) {
    const raced = await findExistingContact(db, accountId, phone)
    return { contactId: raced?.id ?? null, conversationId: null }
  }
  return { contactId: null, conversationId: null }
}

/**
 * Resolve the account's pipeline link once per sync run (not once per
 * order — the currency lookup in particular is wasted work repeated
 * 50-100x otherwise). Returns null when the account hasn't linked a
 * pipeline yet (Settings → Dropi, ROADMAP.md Fase 5).
 */
async function resolvePipelineSync(
  db: SupabaseClient,
  accountId: string,
  config: { pipeline_id?: string | null; status_stage_map?: Record<string, string> | null },
): Promise<PipelineSync | null> {
  if (!config.pipeline_id) return null
  const { data: account } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()
  return {
    pipelineId: config.pipeline_id,
    statusStageMap: config.status_stage_map ?? {},
    defaultCurrency: (account?.default_currency as string) || 'USD',
  }
}

/** Trims + lower-cases a SKU for matching — a Dropi order's SKU and
 *  the catalog's own formatting don't always agree on case/whitespace. */
function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase()
}

/**
 * Resolve the account's SKU → niche-tag map once per sync run
 * (ROADMAP.md Fase 6) — same normalized-SKU matching idea as the
 * dashboard's product-cost cross-reference (`loadOrderStats`,
 * src/lib/dashboard/queries.ts), applied here to `products.niche_tag_id`
 * instead of `products.cost`. Products without a niche assigned are
 * skipped — nothing to tag with.
 */
async function resolveNicheTagMap(
  db: SupabaseClient,
  accountId: string,
): Promise<Map<string, string>> {
  const { data } = await db
    .from('products')
    .select('sku, niche_tag_id')
    .eq('account_id', accountId)
    .not('sku', 'is', null)
    .not('niche_tag_id', 'is', null)

  const map = new Map<string, string>()
  for (const p of (data ?? []) as { sku: string; niche_tag_id: string }[]) {
    map.set(normalizeSku(p.sku), p.niche_tag_id)
  }
  return map
}

/**
 * Find this account's own orders that are still "in flight" — not yet
 * in a delivered status — ordered by whichever hasn't been touched the
 * longest. This is what lets a status change on an OLDER order still
 * get picked up: `listMyOrders` only ever returns the newest orders by
 * creation date, so once more than `sync_batch_size` orders have been
 * created since an order was placed, that order falls out of the
 * regular fetch window forever and its status updates would otherwise
 * be silently missed for the rest of its life in Dropi's pipeline.
 *
 * When `deliveredStatuses` isn't configured yet (Settings → Dropi),
 * every order counts as "in flight" — safe (just means older delivered
 * orders get occasionally re-checked too, no different than a no-op),
 * and it nudges toward configuring delivered_statuses since the
 * dashboard's profit numbers need it anyway (see loadOrderStats).
 */
async function resolveStaleOpenOrderIds(
  db: SupabaseClient,
  accountId: string,
  deliveredStatuses: string[],
  limit: number
): Promise<string[]> {
  let query = db
    .from('orders')
    .select('dropi_order_id')
    .eq('account_id', accountId)
    .order('last_synced_at', { ascending: true })
    .limit(limit)

  if (deliveredStatuses.length > 0) {
    const escaped = deliveredStatuses.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(',')
    query = query.not('status', 'in', `(${escaped})`)
  }

  const { data } = await query
  return ((data ?? []) as { dropi_order_id: string }[]).map((r) => r.dropi_order_id)
}

/**
 * Maps a Dropi order status to the deal's `status` column — 'won' once
 * it's delivered (delivered_statuses, already used for the profit
 * calc), 'lost' if it's in the account's configured lost_statuses
 * (e.g. CANCELADO), 'open' otherwise. Without this, every deal the
 * sync creates stays 'open' forever, which made the Pipeline
 * Analytics "Won this month" / "Lost this month" always read 0 and
 * "Total deals" (which excludes status='lost') count every order ever
 * synced, cancelled or not.
 */
function resolveDealStatus(
  orderStatus: string,
  deliveredStatuses: string[],
  lostStatuses: string[]
): 'open' | 'won' | 'lost' {
  if (deliveredStatuses.includes(orderStatus)) return 'won'
  if (lostStatuses.includes(orderStatus)) return 'lost'
  return 'open'
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
    dealsCreated: 0,
    dealsMoved: 0,
    contactsTagged: 0,
  }

  const { data: config } = await db
    .from('dropi_config')
    .select(
      'integration_key, is_active, notify_customers_enabled, sync_batch_size, never_notify_statuses, delivered_statuses, lost_statuses, pipeline_id, status_stage_map'
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
    const batchSize = (config.sync_batch_size as number) || DEFAULT_BATCH_SIZE
    const neverNotifyStatuses = (config.never_notify_statuses as string[]) ?? []
    const deliveredStatuses = (config.delivered_statuses as string[]) ?? []
    const lostStatuses = (config.lost_statuses as string[]) ?? []
    const pipeline = await resolvePipelineSync(db, accountId, config)
    const nicheTagBySku = await resolveNicheTagMap(db, accountId)

    let orders: DropiOrder[]
    try {
      orders = await listMyOrders({ integrationKey, resultNumber: batchSize })
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'unknown Dropi API error'
      console.error(`[dropi/sync] listMyOrders failed for account ${accountId}:`, result.error)
      return result
    }
    result.fetched = orders.length
    result.mayHaveMore = orders.length === batchSize

    const seenOrderIds = new Set<string>()
    for (const order of orders) {
      seenOrderIds.add(String(order.id))
      await upsertOneOrder(db, accountId, order, result, {
        notifyEnabled: config.notify_customers_enabled,
        neverNotifyStatuses,
        pipeline,
        nicheTagBySku,
        deliveredStatuses,
        lostStatuses,
      })
    }

    // Second pass: refresh a bounded batch of this account's own
    // still-open orders, oldest-synced first, so status changes on
    // orders that fell out of the "newest N" window above still reach
    // customers and the pipeline/dashboard. See resolveStaleOpenOrderIds.
    const staleOrderIds = await resolveStaleOpenOrderIds(db, accountId, deliveredStatuses, batchSize)
    for (const dropiOrderId of staleOrderIds) {
      if (seenOrderIds.has(dropiOrderId)) continue
      try {
        const order = await getOrderById({ integrationKey, dropiOrderId })
        await upsertOneOrder(db, accountId, order, result, {
          notifyEnabled: config.notify_customers_enabled,
          neverNotifyStatuses,
          pipeline,
          nicheTagBySku,
          deliveredStatuses,
          lostStatuses,
        })
      } catch (err) {
        // Best-effort — one order failing to refresh (deleted on Dropi's
        // side, transient network error) must not block the rest of the
        // stale-order queue or the sync overall.
        console.error(
          `[dropi/sync] stale-order refresh failed for order ${dropiOrderId} (account ${accountId}):`,
          err
        )
      }
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
 * regular (last-N) sync and the full backfill below. `notifyEnabled`
 * is passed explicitly (rather than re-read from config) so the
 * backfill can force it off unconditionally regardless of the
 * account's saved setting — see backfillAccountDropiOrders.
 */
async function upsertOneOrder(
  db: SupabaseClient,
  accountId: string,
  order: DropiOrder,
  result: DropiSyncResult,
  notify: {
    notifyEnabled: boolean
    neverNotifyStatuses: string[]
    pipeline: PipelineSync | null
    nicheTagBySku: Map<string, string>
    deliveredStatuses: string[]
    lostStatuses: string[]
  }
): Promise<void> {
  const dropiOrderId = String(order.id)

  const { data: existing } = await db
    .from('orders')
    .select('id, status, contact_id, conversation_id, deal_id')
    .eq('account_id', accountId)
    .eq('dropi_order_id', dropiOrderId)
    .maybeSingle()

  // Only pay for contact/conversation resolution when the order doesn't
  // already have one — the common case after the first sync. This also
  // means an order synced before WhatsApp was connected picks up the
  // link on its next sync once WhatsApp is set up, without needing a
  // backfill re-run.
  let contactId = existing?.contact_id ?? null
  let conversationId = existing?.conversation_id ?? null
  if (!contactId) {
    const resolved = await resolveOrderContact(
      db,
      accountId,
      order.phone ? String(order.phone) : '',
      [order.name, order.surname].filter(Boolean).join(' ').trim() || null,
    )
    contactId = resolved.contactId
    conversationId = resolved.conversationId
  }

  const row = mapDropiOrderToRow(accountId, order, contactId, conversationId)
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

  // Pipeline sync (ROADMAP.md Fase 5): create the deal the first time
  // an order maps to a known stage, then only ever move it — never
  // touch title/value again once created, so edits the team makes by
  // hand in Pipelines survive future syncs. An order whose status
  // isn't in the map is left alone (deal stays wherever it is, or
  // never gets created).
  const targetStageId = notify.pipeline?.statusStageMap[order.status]
  if (notify.pipeline && targetStageId) {
    if (!existing?.deal_id) {
      try {
        const ownerUserId = await resolveAuditUserId(db, accountId)
        const customerName = [order.name, order.surname].filter(Boolean).join(' ')
        const { data: deal } = await db
          .from('deals')
          .insert({
            account_id: accountId,
            user_id: ownerUserId,
            pipeline_id: notify.pipeline.pipelineId,
            stage_id: targetStageId,
            contact_id: upserted.contact_id,
            title: `Pedido #${dropiOrderId}${customerName ? ` — ${customerName}` : ''}`,
            value: order.total_order ?? 0,
            currency: notify.pipeline.defaultCurrency,
            status: resolveDealStatus(order.status, notify.deliveredStatuses, notify.lostStatuses),
          })
          .select('id')
          .single()
        if (deal) {
          await db.from('orders').update({ deal_id: deal.id }).eq('id', upserted.id)
          result.dealsCreated++
        }
      } catch (err) {
        // Best-effort — a contact/account lookup failure here must
        // never break the order sync itself.
        console.error(`[dropi/sync] deal creation failed for order ${dropiOrderId}:`, err)
      }
    } else if (statusChanged) {
      const { error: moveErr } = await db
        .from('deals')
        .update({
          stage_id: targetStageId,
          status: resolveDealStatus(order.status, notify.deliveredStatuses, notify.lostStatuses),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.deal_id)
        .eq('account_id', accountId)
      if (!moveErr) result.dealsMoved++
    }
  }

  // Niche tagging (ROADMAP.md Fase 6): only the first time this order
  // is seen — an order's line items don't change on resync, so
  // re-tagging every run would just be repeat no-ops through
  // addContactTagIfAbsent. A single order can carry products from
  // several niches at once; every matching one gets applied.
  if (!existing && upserted.contact_id && notify.nicheTagBySku.size > 0) {
    const nicheTagIds = new Set<string>()
    for (const line of order.orderdetails ?? []) {
      const sku = line.product?.sku
      if (!sku) continue
      const tagId = notify.nicheTagBySku.get(normalizeSku(sku))
      if (tagId) nicheTagIds.add(tagId)
    }
    for (const tagId of nicheTagIds) {
      try {
        const added = await addContactTagIfAbsent(db, {
          accountId,
          contactId: upserted.contact_id,
          tagId,
        })
        if (added) result.contactsTagged++
      } catch (err) {
        // Best-effort — a tagging failure must never break the order sync.
        console.error(`[dropi/sync] niche tagging failed for order ${dropiOrderId}:`, err)
      }
    }
  }

  // Dispatch: only on a genuine status change to a pre-existing order,
  // only if notifications are on for the account, and only if the new
  // status isn't in the never-notify list (e.g. CANCELADO).
  if (
    existing &&
    statusChanged &&
    notify.notifyEnabled &&
    !notify.neverNotifyStatuses.includes(order.status) &&
    upserted.contact_id
  ) {
    try {
      const productSummary = (order.orderdetails ?? [])
        .map((d) => d.product?.name)
        .filter(Boolean)
        .join(', ')

      const { matchedCount } = await runAutomationsForTrigger({
        accountId,
        triggerType: 'order_status_changed',
        contactId: upserted.contact_id,
        context: {
          conversation_id: upserted.conversation_id ?? undefined,
          order_id: upserted.id,
          order_from_status: existing.status,
          order_to_status: order.status,
          vars: {
            customer_name: [order.name, order.surname].filter(Boolean).join(' '),
            product_summary: productSummary,
            total_order: order.total_order,
            address: order.dir,
            city: order.city,
            shipping_company: order.shipping_company ?? '',
            shipping_guide: order.shipping_guide ?? '',
            to_status: order.status,
            from_status: existing.status,
          },
        },
      })

      if (matchedCount > 0) {
        result.notified++
        if (statusEventId) {
          await db
            .from('order_status_events')
            .update({ customer_notified: true })
            .eq('id', statusEventId)
        }
      }
    } catch {
      // Best-effort: dispatch must never break the sync for other orders.
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
 * history must never be mistaken for a live status change and dispatch
 * automations for a customer from three months ago.
 *
 * Meant to be triggered manually (a separate, explicit "Import full
 * history" action) — NOT wired into the recurring cron, since it can
 * be a much heavier call against a live account than the routine
 * last-N check.
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
    dealsCreated: 0,
    dealsMoved: 0,
    contactsTagged: 0,
  }

  const { data: config } = await db
    .from('dropi_config')
    .select('integration_key, is_active, pipeline_id, status_stage_map, delivered_statuses, lost_statuses')
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
    // Deal linking and niche tagging are structural, customer-invisible
    // side effects (unlike notifications, which stay hard-disabled
    // below) — safe to apply retroactively so historical orders land on
    // the right pipeline column and their contacts pick up niche tags too.
    const pipeline = await resolvePipelineSync(db, accountId, config)
    const nicheTagBySku = await resolveNicheTagMap(db, accountId)
    const deliveredStatuses = (config.delivered_statuses as string[]) ?? []
    const lostStatuses = (config.lost_statuses as string[]) ?? []

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
          neverNotifyStatuses: [],
          pipeline,
          nicheTagBySku,
          deliveredStatuses,
          lostStatuses,
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
