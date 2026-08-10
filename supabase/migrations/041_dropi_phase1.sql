-- ============================================================
-- 041_dropi_phase1.sql — Dropi orders module, phase 1 close-out
--
-- Adds two account-level settings the sync loop needs:
--   - sync_batch_size: how many orders `syncAccountDropiOrders` asks
--     Dropi for per run (was hardcoded to 50). Configurable per
--     account so a higher-volume operation can raise it as their
--     order flow grows.
--   - never_notify_statuses: statuses that must never fire a customer
--     notification (e.g. CANCELADO) — checked before dispatching the
--     new `order_status_changed` automation trigger (see
--     src/lib/dropi/sync.ts). Dropi's status vocabulary isn't a fixed
--     enum (confirmed against the live account), so this is free text,
--     matched verbatim against `orders.status`.
--
-- Purely additive — does not touch existing rows or any other column.
-- Idempotent, same style as 037-039.
-- ============================================================

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS sync_batch_size integer NOT NULL DEFAULT 50;

ALTER TABLE dropi_config
  DROP CONSTRAINT IF EXISTS dropi_config_sync_batch_size_check;

ALTER TABLE dropi_config
  ADD CONSTRAINT dropi_config_sync_batch_size_check
    CHECK (sync_batch_size BETWEEN 10 AND 500);

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS never_notify_statuses text[] NOT NULL DEFAULT '{}';
