-- ============================================================
-- 037_dropi_orders.sql — Dropi logistics integration (config + orders)
--
-- Adds the account-level Dropi connection (mirrors whatsapp_config /
-- ai_configs: one per account, BYO integration key, encrypted at
-- rest) and a new `orders` table that mirrors the real fields Dropi's
-- Integrations API returns (verified against a live account, not
-- guessed from docs alone).
--
-- Design notes
--   - `dropi_config` is account-scoped and UNIQUE(account_id), same
--     shape as `whatsapp_config` / `ai_configs`. `integration_key` is
--     the `dropi-integration-key` token, AES-256-GCM-encrypted with
--     the same encrypt()/decrypt() used for WhatsApp tokens and AI
--     provider keys — never stored or returned in plaintext.
--
--   - TWO independent kill switches, both default OFF:
--       * is_active                — master switch. Off = the sync
--         job does not call Dropi at all, nothing is read or written.
--       * notify_customers_enabled — separate switch just for the
--         "message the customer on new/changed order" behaviour. Off
--         = orders still sync into the CRM (visible, filterable) but
--         NOT ONE WhatsApp message goes out. This lets an operator
--         validate the sync against their real, live Dropi account
--         (real orders, real customers) before risking a single
--         message to a real person. Never default this to true.
--
--   - `orders` is NOT the same concept as `deals`: a deal is a sales
--     opportunity (negotiation stage, expected close date); an order
--     is a fulfillment record (address, carrier, shipping guide). A
--     deal can close with no order yet; an order can exist against an
--     already-closed deal (repeat purchase) or with no deal at all
--     (Dropi/Shopify order synced independently). Kept as separate
--     tables, optionally linked, following the same nullable-FK-with-
--     SET-NULL pattern used everywhere else in this schema (deals,
--     conversations, contacts) so deleting a deal/contact never loses
--     order history.
--
--   - UNIQUE(account_id, dropi_order_id) makes the sync job's upsert
--     idempotent — re-running the cron on the same Dropi order never
--     duplicates a row.
--
-- RLS
--   dropi_config: settings-class, mirrors whatsapp_config — any
--   member (viewer+) may read (the UI needs to know whether it's
--   configured/active), only admin+ may create/update/delete.
--
--   orders: operational data, mirrors deals/contacts — viewer+ reads,
--   agent+ writes. The sync cron runs under the service-role client
--   (no auth.uid()), so RLS guards dashboard access, not the sync job.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- DROPI_CONFIG
-- ============================================================
CREATE TABLE IF NOT EXISTS dropi_config (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id                  UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  integration_key             TEXT NOT NULL,              -- AES-256-GCM-encrypted dropi-integration-key
  is_active                   BOOLEAN NOT NULL DEFAULT false,
  notify_customers_enabled    BOOLEAN NOT NULL DEFAULT false,
  notify_template_name        TEXT,        -- approved WhatsApp template used for status-change messages
  last_synced_at              TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dropi_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dropi_config_select ON dropi_config;
CREATE POLICY dropi_config_select ON dropi_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS dropi_config_insert ON dropi_config;
CREATE POLICY dropi_config_insert ON dropi_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS dropi_config_update ON dropi_config;
CREATE POLICY dropi_config_update ON dropi_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS dropi_config_delete ON dropi_config;
CREATE POLICY dropi_config_delete ON dropi_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON dropi_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON dropi_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
  conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,

  -- Dropi identifiers
  dropi_order_id      TEXT NOT NULL,        -- Dropi's own order id ("id" in /orders/myorders)
  shop_order_id       TEXT,                 -- origin-platform order id (e.g. Shopify order id)
  shop_order_number   INTEGER,

  -- Fulfillment status (Dropi's own vocabulary, kept as free text —
  -- Dropi does not publish a closed enum and we've observed values
  -- like "PENDIENTE CONFIRMACION" that aren't in the PDF docs).
  status               TEXT NOT NULL,

  -- Customer / shipping (as returned by Dropi, not normalized —
  -- these are snapshot fields for the order, independent of whatever
  -- is on file in `contacts` at sync time)
  customer_name        TEXT,
  customer_surname     TEXT,
  customer_phone       TEXT,
  address              TEXT,
  city                 TEXT,
  state                TEXT,

  -- Money
  total_order          NUMERIC(12,2),
  shipping_amount      NUMERIC(12,2),
  currency             TEXT DEFAULT 'COP',

  -- Carrier / guide
  shipping_company     TEXT,
  distribution_company_id INTEGER,
  sticker              TEXT,                -- guide filename, used to fetch the PDF
  guide_was_downloaded BOOLEAN DEFAULT false,

  raw                  JSONB,                -- full Dropi order payload, for fields we haven't modeled yet

  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, dropi_order_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_account       ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(account_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_contact        ON orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_deal           ON orders(deal_id);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_delete ON orders;
CREATE POLICY orders_delete ON orders FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Status-change audit log — mirrors automation_logs / flow_run_events:
-- every time the sync job sees a status change, it records the
-- transition here. Lets us tell "we already notified for this
-- transition" apart from "this is a new change we haven't acted on
-- yet" without overloading `orders.status` itself, and gives an
-- operator a visible history per order.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_status_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  customer_notified BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_status_events_order ON order_status_events(order_id);

ALTER TABLE order_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_status_events_select ON order_status_events;
CREATE POLICY order_status_events_select ON order_status_events FOR SELECT
  USING (is_account_member(account_id));
-- Service-role (sync cron) inserts; no client INSERT/UPDATE/DELETE policy.
