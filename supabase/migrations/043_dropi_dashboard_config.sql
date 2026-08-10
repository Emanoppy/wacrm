-- ============================================================
-- 043_dropi_dashboard_config.sql — ROADMAP.md Fase 4
--
-- Dropi's status vocabulary isn't a fixed enum (confirmed repeatedly
-- against the live account), so "confirmed" and "delivered" — needed
-- to compute confirmation/delivery rate on the dashboard — are
-- configurable per account, same pattern as `never_notify_statuses`
-- (migration 041). Defaults are seeded from the real statuses already
-- observed on this account (GUIA_GENERADA, ENTREGADO) so the
-- dashboard isn't stuck at 0% before anyone visits Settings.
--
-- `default_shipping_cost` is a fallback only — most orders already
-- carry a real `orders.shipping_amount` from Dropi; this fills in for
-- the rare row where Dropi didn't report one.
--
-- Purely additive. Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS confirmed_statuses text[] NOT NULL DEFAULT '{GUIA_GENERADA,ENTREGADO}';

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS delivered_statuses text[] NOT NULL DEFAULT '{ENTREGADO}';

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS default_shipping_cost numeric(12,2);
