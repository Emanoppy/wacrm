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

    const { data, error } = await supabase
      .from('dropi_config')
      .select(
        'integration_key, is_active, notify_customers_enabled, notify_template_name, last_synced_at',
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
    const notifyTemplateName =
      typeof body.notify_template_name === 'string' && body.notify_template_name.trim()
        ? body.notify_template_name.trim()
        : null

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

    const shared = {
      is_active: isActive,
      notify_customers_enabled: notifyEnabled,
      notify_template_name: notifyTemplateName,
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
