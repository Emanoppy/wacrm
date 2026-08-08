-- ============================================================
-- 039_dropi_order_created_at.sql — Dropi's own order creation date
--
-- `orders.created_at` (added in 037) is a Postgres-managed timestamp
-- — it means "when did wacrm first see this row", which for a
-- backfilled historical order is the moment of the import, not when
-- the order actually happened. `dropi_created_at` is the value Dropi
-- itself reports for the order, so the Orders page can sort/display
-- by when the order was really placed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS dropi_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_dropi_created_at
  ON orders(account_id, dropi_created_at DESC);
