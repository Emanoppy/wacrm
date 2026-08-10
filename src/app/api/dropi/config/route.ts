import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { listDepartments, DropiApiError } from '@/lib/dropi/client'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
}

/**
 * GET /api/dropi/config
 *
 * Any member may read so the Orders page / settings rail can reflect
 * whether Dropi is connected. The encrypted key is NEVER returned —
 * only a `has_key` flag (mirrors /api/ai/config, /api/whatsapp/config).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    // notify_template_name is intentionally not selected — superseded by
    // the order_status_changed automation trigger (see sync.ts header
    // comment). The column stays in the DB (not dropped, avoids a
    // destructive migration on live data) but nothing reads it anymore.
    const { data, error } = await supabase
      .from('dropi_config')
      .select(
        'integration_key, is_active, notify_customers_enabled, sync_batch_size, never_notify_statuses, confirmed_statuses, delivered_statuses, lost_statuses, default_shipping_cost, pipeline_id, status_stage_map, last_synced_at',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[dropi/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load Dropi configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    const { integration_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!integration_key,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/dropi/config  (admin+)
 *
 * Upsert the account's Dropi connection. Verifies the key against the
 * real Dropi API (a cheap /department call) before persisting — same
 * "verify before save" discipline as WhatsApp/AI config. When
 * `integration_key` is omitted, the existing stored key is reused (the
 * form only sends it when re-entered).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`dropi-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const isActive = body.is_active === true
    const notifyEnabled = body.notify_customers_enabled === true

    let syncBatchSize = Number(body.sync_batch_size)
    if (!Number.isFinite(syncBatchSize)) syncBatchSize = 50
    syncBatchSize = Math.min(500, Math.max(10, Math.floor(syncBatchSize)))

    const neverNotifyStatuses = stringArray(body.never_notify_statuses)
    const confirmedStatuses = stringArray(body.confirmed_statuses)
    const deliveredStatuses = stringArray(body.delivered_statuses)
    const lostStatuses = stringArray(body.lost_statuses)

    let defaultShippingCost: number | null = null
    if (body.default_shipping_cost !== undefined && body.default_shipping_cost !== null && body.default_shipping_cost !== '') {
      const n = Number(body.default_shipping_cost)
      defaultShippingCost = Number.isFinite(n) ? n : null
    }

    const pipelineId = typeof body.pipeline_id === 'string' && body.pipeline_id ? body.pipeline_id : null
    const rawStatusStageMap =
      body.status_stage_map && typeof body.status_stage_map === 'object' && !Array.isArray(body.status_stage_map)
        ? (body.status_stage_map as Record<string, unknown>)
        : {}

    const rawKey =
      typeof body.integration_key === 'string' ? body.integration_key.trim() : ''

    const { data: existing } = await supabase
      .from('dropi_config')
      .select('id, integration_key')
      .eq('account_id', accountId)
      .maybeSingle()

    let keyPlain: string
    if (rawKey) {
      keyPlain = rawKey
    } else if (existing?.integration_key) {
      try {
        keyPlain = decrypt(existing.integration_key)
      } catch {
        return bad('Stored Dropi key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('integration_key is required')
    }

    // Only spend a round-trip to Dropi when the key actually changed —
    // a save that just flips a switch skips it.
    if (rawKey) {
      try {
        await listDepartments({ integrationKey: keyPlain })
      } catch (err) {
        const message =
          err instanceof DropiApiError
            ? err.message
            : 'Could not reach the Dropi API.'
        return bad(`Dropi rejected the key: ${message}`)
      }
    }

    // Defense in depth: a pipeline/stage id from the client must
    // actually belong to this account before it's linked — same
    // discipline the automations engine uses for create_deal's
    // pipeline_id/stage_id.
    const statusStageMap: Record<string, string> = {}
    if (pipelineId) {
      const { data: pipeline } = await supabase
        .from('pipelines')
        .select('id')
        .eq('id', pipelineId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!pipeline) return bad('pipeline_id is not a pipeline on this account')

      const { data: stages } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipelineId)
      const validStageIds = new Set((stages ?? []).map((s) => s.id as string))

      for (const [status, stageId] of Object.entries(rawStatusStageMap)) {
        if (typeof stageId === 'string' && validStageIds.has(stageId)) {
          statusStageMap[status] = stageId
        }
      }
    }

    const shared = {
      is_active: isActive,
      notify_customers_enabled: notifyEnabled,
      sync_batch_size: syncBatchSize,
      never_notify_statuses: neverNotifyStatuses,
      confirmed_statuses: confirmedStatuses,
      delivered_statuses: deliveredStatuses,
      lost_statuses: lostStatuses,
      default_shipping_cost: defaultShippingCost,
      pipeline_id: pipelineId,
      status_stage_map: statusStageMap,
    }
    const encryptedKey = rawKey ? encrypt(rawKey) : null

    if (existing) {
      const { error: upErr } = await supabase
        .from('dropi_config')
        .update(encryptedKey ? { ...shared, integration_key: encryptedKey } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[dropi/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save Dropi configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('dropi_config').insert({
        account_id: accountId,
        created_by: userId,
        integration_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[dropi/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save Dropi configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/dropi/config  (admin+)
 *
 * Disconnects Dropi — removes the key and turns sync/notifications
 * off. Does NOT delete previously-synced `orders` rows.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('dropi_config')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[dropi/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete Dropi configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
