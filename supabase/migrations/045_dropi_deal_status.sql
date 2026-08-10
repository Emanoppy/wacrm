-- ============================================================
-- 045_dropi_deal_status.sql
--
-- Fase 5 (migration 044) created a `deals` row per synced order but
-- left `status` hardcoded to 'open' forever — so the Pipeline
-- Analytics widget's "Won this month" / "Lost this month" were
-- structurally always 0, and "Total deals" (which excludes
-- status='lost') counted every order ever synced, including
-- cancelled ones. This column lets the account define which Dropi
-- statuses mean the deal is definitively lost, mirroring the
-- existing `delivered_statuses` pattern (migration 043) used to mark
-- a deal "won" — same reasoning: Dropi's status vocabulary isn't a
-- fixed enum, so this must be configurable per account, not hardcoded.
--
-- Deliberately does NOT default to any value — unlike
-- delivered_statuses/confirmed_statuses (which had an obvious seed
-- from the live account's real statuses), which Dropi statuses count
-- as "lost" is a business call (e.g. whether DEVOLUCION counts) that
-- the account owner should make explicitly in Settings, not inherit
-- a guess.
--
-- Purely additive. Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS lost_statuses text[] NOT NULL DEFAULT '{}';
