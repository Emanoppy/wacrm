import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

export interface ProductKnowledgeInput {
  id: string
  name: string
  sale_price: number | null
  description: string | null
  technical_spec: string | null
  knowledge_document_id: string | null
}

/** Formats a product's fields into the plain-text block that becomes
 *  the AI knowledge-base document content — what the assistant sees
 *  verbatim when it retrieves this product during a sales chat. */
function buildKnowledgeContent(product: ProductKnowledgeInput): string {
  const lines = [`Producto: ${product.name}`]
  if (product.sale_price != null) lines.push(`Precio: ${product.sale_price}`)
  if (product.description) lines.push(`Descripción: ${product.description}`)
  if (product.technical_spec) lines.push(`Ficha técnica / preguntas frecuentes:\n${product.technical_spec}`)
  return lines.join('\n')
}

/**
 * Keep a product's linked `ai_knowledge_documents` row (and its
 * chunks) in sync with the product's current fields — creates the
 * document on first sync, re-ingests in place on every later save.
 * Must run under a client allowed to write `ai_knowledge_documents`
 * (admin-gated by RLS — callers use the service-role client after
 * their own role check, same as the Dropi sync routes).
 *
 * Never throws for an indexing failure — that would block saving the
 * product over a knowledge-base hiccup. The document/chunks are best-
 * effort; the returned `warning` lets the caller surface it.
 */
export async function syncProductKnowledge(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  product: ProductKnowledgeInput,
): Promise<{ knowledgeDocumentId: string | null; warning?: string }> {
  const title = product.name
  const content = buildKnowledgeContent(product)

  let documentId = product.knowledge_document_id

  if (documentId) {
    const { error } = await db
      .from('ai_knowledge_documents')
      .update({ title, content })
      .eq('id', documentId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[products/knowledge-sync] document update error:', error)
      return { knowledgeDocumentId: documentId, warning: 'Failed to update knowledge base document.' }
    }
  } else {
    const { data: doc, error } = await db
      .from('ai_knowledge_documents')
      .insert({ account_id: accountId, created_by: userId, title, content })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[products/knowledge-sync] document insert error:', error)
      return { knowledgeDocumentId: null, warning: 'Failed to create knowledge base document.' }
    }
    documentId = doc.id
  }
  // Every path above either returns early or sets documentId to a real
  // id, but TS can't prove a mutable `let` stays non-null across the
  // if/else join — this is an invariant check, not a real runtime path.
  if (!documentId) throw new Error('unreachable: documentId not resolved')
  const resolvedDocumentId = documentId

  const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(db, accountId)
  try {
    await ingestDocument(db, accountId, { embeddingsApiKey }, resolvedDocumentId, content)
  } catch (err) {
    const message = err instanceof AiError ? err.message : 'indexing failed'
    console.error('[products/knowledge-sync] ingest error:', err)
    return {
      knowledgeDocumentId: resolvedDocumentId,
      warning: `Saved, but semantic indexing failed (${message}). Keyword search still works.`,
    }
  }

  if (corrupt) {
    return {
      knowledgeDocumentId: resolvedDocumentId,
      warning: 'Saved with keyword search only — the embeddings key could not be decrypted.',
    }
  }
  return { knowledgeDocumentId: resolvedDocumentId }
}

/** Removes a product's linked knowledge-base document (and its
 *  chunks, via the FK's cascade — see migration 030) when the product
 *  is deleted, so the AI stops citing a discontinued product. */
export async function deleteProductKnowledge(
  db: SupabaseClient,
  accountId: string,
  knowledgeDocumentId: string | null,
): Promise<void> {
  if (!knowledgeDocumentId) return
  const { error } = await db
    .from('ai_knowledge_documents')
    .delete()
    .eq('id', knowledgeDocumentId)
    .eq('account_id', accountId)
  if (error) {
    console.error('[products/knowledge-sync] document delete error:', error)
  }
}
