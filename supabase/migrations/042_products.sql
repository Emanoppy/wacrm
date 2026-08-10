-- ============================================================
-- 042_products.sql — Products module (ROADMAP.md, Fase 2)
--
-- A per-account product catalog: sale price, cost (needed for the
-- profit math in Fase 4), a technical spec/FAQ, photos, and an
-- optional "niche" tag. The niche is modeled as a single nullable FK
-- into the EXISTING `tags` table rather than a new categories table —
-- Fase 6 (remarketing) will call the existing
-- `addContactTagIfAbsent(db, {accountId, contactId, tagId})` helper
-- with `tagId = products.niche_tag_id` when a Dropi order for this
-- product syncs, so no future schema change is needed for that.
--
-- `knowledge_document_id` links each product to a row in the
-- EXISTING AI knowledge base (`ai_knowledge_documents`, migration
-- 030) — the product's spec/FAQ is kept in sync there so the AI reply
-- assistant can answer product questions during a sales conversation
-- without new retrieval code (see src/lib/products/knowledge-sync.ts).
--
-- RLS: operational data, same tier as `orders`/`deals` — any member
-- reads, agent+ writes (day-to-day catalog upkeep, not admin-gated
-- settings). Note the API routes that write here also write to
-- `ai_knowledge_documents`, which IS admin-gated — those routes use
-- the service-role client after their own `requireRole('agent')`
-- check, same pattern the Dropi sync routes already use for the same
-- reason (see src/app/api/dropi/sync/route.ts).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  sku                   text,
  sale_price            numeric(12,2),
  cost                  numeric(12,2),
  description           text,
  technical_spec        text,
  image_urls            text[] NOT NULL DEFAULT '{}',
  niche_tag_id          uuid REFERENCES tags(id) ON DELETE SET NULL,
  knowledge_document_id uuid REFERENCES ai_knowledge_documents(id) ON DELETE SET NULL,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_account ON products(account_id);
CREATE INDEX IF NOT EXISTS idx_products_niche_tag ON products(niche_tag_id);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS products_insert ON products;
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_update ON products;
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_delete ON products;
CREATE POLICY products_delete ON products FOR DELETE
  USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION public.update_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION public.update_products_updated_at();

-- ============================================================
-- product-media storage bucket — mirrors chat-media (023) /
-- flow-media (016+020): public reads, account-scoped writes at
-- product-media/account-<account_id>/<timestamp>-<basename>.<ext>.
-- Images only, 5 MB cap (matches MEDIA_MAX_BYTES_BY_KIND.image in
-- src/lib/storage/upload-media.ts).
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-media',
  'product-media',
  TRUE,
  5242880, -- 5 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Product media is publicly readable" ON storage.objects;
CREATE POLICY "Product media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-media');

DROP POLICY IF EXISTS "Members can upload product media" ON storage.objects;
CREATE POLICY "Members can upload product media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'product-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update product media" ON storage.objects;
CREATE POLICY "Members can update product media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'product-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete product media" ON storage.objects;
CREATE POLICY "Members can delete product media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'product-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
