import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { syncProductKnowledge, deleteProductKnowledge } from '@/lib/products/knowledge-sync'

type Params = { params: Promise<{ id: string }> }

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * PATCH /api/products/[id]  (agent+)
 *
 * Updates a product and re-syncs its linked knowledge-base document.
 * See the POST route's comment for why this runs under the
 * service-role client despite `products` itself being agent-writable.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`products:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const admin = supabaseAdmin()

    const { data: existing } = await admin
      .from('products')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const name = typeof body.name === 'string' ? body.name.trim() : existing.name
    if (!name) return bad('name is required')

    const nicheTagId = 'niche_tag_id' in body
      ? (typeof body.niche_tag_id === 'string' ? body.niche_tag_id : null)
      : existing.niche_tag_id

    if (nicheTagId && nicheTagId !== existing.niche_tag_id) {
      const { data: tag } = await admin
        .from('tags')
        .select('id')
        .eq('id', nicheTagId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!tag) return bad('niche_tag_id is not a tag on this account')
    }

    const update = {
      name,
      sku: typeof body.sku === 'string' ? body.sku.trim() || null : existing.sku,
      sale_price: body.sale_price !== undefined ? (body.sale_price != null ? Number(body.sale_price) : null) : existing.sale_price,
      cost: body.cost !== undefined ? (body.cost != null ? Number(body.cost) : null) : existing.cost,
      description:
        typeof body.description === 'string' ? body.description.trim() || null : existing.description,
      technical_spec:
        typeof body.technical_spec === 'string'
          ? body.technical_spec.trim() || null
          : existing.technical_spec,
      image_urls: Array.isArray(body.image_urls)
        ? body.image_urls.filter((u: unknown) => typeof u === 'string')
        : existing.image_urls,
      niche_tag_id: nicheTagId,
      is_active: typeof body.is_active === 'boolean' ? body.is_active : existing.is_active,
    }

    const { error: upErr } = await admin.from('products').update(update).eq('id', id)
    if (upErr) {
      console.error('[products/[id] PATCH] update error:', upErr)
      return NextResponse.json({ error: 'Failed to update product' }, { status: 500 })
    }

    const { knowledgeDocumentId, warning } = await syncProductKnowledge(admin, accountId, userId, {
      id,
      name: update.name,
      sale_price: update.sale_price,
      description: update.description,
      technical_spec: update.technical_spec,
      knowledge_document_id: existing.knowledge_document_id,
    })

    if (knowledgeDocumentId && knowledgeDocumentId !== existing.knowledge_document_id) {
      await admin.from('products').update({ knowledge_document_id: knowledgeDocumentId }).eq('id', id)
    }

    return NextResponse.json({ success: true, warning })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/products/[id]  (agent+) — also removes the linked
 * knowledge-base document so the AI stops citing a discontinued
 * product (chunks cascade with it, see migration 030).
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await params
    const admin = supabaseAdmin()

    const { data: existing } = await admin
      .from('products')
      .select('knowledge_document_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { error } = await admin.from('products').delete().eq('id', id).eq('account_id', accountId)
    if (error) {
      console.error('[products/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 })
    }

    await deleteProductKnowledge(admin, accountId, existing.knowledge_document_id)

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
