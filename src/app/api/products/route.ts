import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { syncProductKnowledge } from '@/lib/products/knowledge-sync'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * POST /api/products  (agent+)
 *
 * Creates a product and keeps its linked AI-knowledge-base document in
 * sync (see src/lib/products/knowledge-sync.ts). Runs the writes under
 * the service-role client — `ai_knowledge_documents` is admin-gated by
 * RLS (migration 030), so an agent-role caller's own RLS-bound client
 * would be rejected there even though `products` itself allows agent+.
 * `requireRole('agent')` is what actually enforces the auth boundary;
 * every write below is still explicitly scoped to `accountId`. Same
 * pattern as the Dropi sync routes (see src/app/api/dropi/sync/route.ts).
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`products:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return bad('name is required')

    const sku = typeof body.sku === 'string' ? body.sku.trim() || null : null
    const salePrice = body.sale_price != null ? Number(body.sale_price) : null
    const cost = body.cost != null ? Number(body.cost) : null
    const description = typeof body.description === 'string' ? body.description.trim() || null : null
    const technicalSpec =
      typeof body.technical_spec === 'string' ? body.technical_spec.trim() || null : null
    const imageUrls = Array.isArray(body.image_urls)
      ? body.image_urls.filter((u: unknown) => typeof u === 'string')
      : []
    const nicheTagId = typeof body.niche_tag_id === 'string' ? body.niche_tag_id : null

    const admin = supabaseAdmin()

    // Defense in depth: a tag id from the client must actually belong
    // to this account before it's linked, same discipline the
    // automations engine uses for add_tag.
    if (nicheTagId) {
      const { data: tag } = await admin
        .from('tags')
        .select('id')
        .eq('id', nicheTagId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!tag) return bad('niche_tag_id is not a tag on this account')
    }

    const { data: product, error: insErr } = await admin
      .from('products')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        sku,
        sale_price: salePrice,
        cost,
        description,
        technical_spec: technicalSpec,
        image_urls: imageUrls,
        niche_tag_id: nicheTagId,
      })
      .select('*')
      .single()

    if (insErr || !product) {
      console.error('[products POST] insert error:', insErr)
      return NextResponse.json({ error: 'Failed to create product' }, { status: 500 })
    }

    const { knowledgeDocumentId, warning } = await syncProductKnowledge(admin, accountId, userId, {
      id: product.id,
      name,
      sale_price: salePrice,
      description,
      technical_spec: technicalSpec,
      knowledge_document_id: null,
    })

    if (knowledgeDocumentId) {
      await admin
        .from('products')
        .update({ knowledge_document_id: knowledgeDocumentId })
        .eq('id', product.id)
      product.knowledge_document_id = knowledgeDocumentId
    }

    return NextResponse.json({ success: true, product, warning })
  } catch (err) {
    return toErrorResponse(err)
  }
}
