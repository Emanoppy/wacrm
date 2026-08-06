import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { listDepartments, DropiApiError } from '@/lib/dropi/client'

/**
 * POST /api/dropi/test  (admin+)
 *
 * "Verificar conexión" button: validate a candidate integration key
 * against the real Dropi API WITHOUT saving (calls the cheap,
 * read-only /department endpoint). When `integration_key` is omitted
 * the stored key is used, so an admin can re-test an existing config.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`dropi-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => ({}))
    const rawKey =
      typeof body?.integration_key === 'string' ? body.integration_key.trim() : ''

    let keyPlain = rawKey
    if (!keyPlain) {
      const { data: existing } = await supabase
        .from('dropi_config')
        .select('integration_key')
        .eq('account_id', accountId)
        .maybeSingle()
      if (!existing?.integration_key) {
        return NextResponse.json(
          { error: 'Enter a Dropi key to test.' },
          { status: 400 },
        )
      }
      try {
        keyPlain = decrypt(existing.integration_key)
      } catch {
        return NextResponse.json(
          { error: 'Stored key could not be decrypted — re-enter your key.' },
          { status: 400 },
        )
      }
    }

    try {
      const departments = await listDepartments({ integrationKey: keyPlain })
      return NextResponse.json({ ok: true, departmentCount: departments.length })
    } catch (err) {
      const message =
        err instanceof DropiApiError ? err.message : 'Could not reach the Dropi API.'
      return NextResponse.json({ error: message }, { status: 400 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
