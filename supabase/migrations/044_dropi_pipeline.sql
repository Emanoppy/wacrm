-- ============================================================
-- 044_dropi_pipeline.sql — ROADMAP.md Fase 5
--
-- Links a Dropi-connected account to one pipeline (existing
-- `pipelines` table) and maps each of that account's real Dropi
-- statuses to a stage in it, so `src/lib/dropi/sync.ts` can create/
-- move `orders.deal_id` automatically as the order's status changes.
--
-- `status_stage_map` is `{ "<dropi status text>": "<stage uuid>" }` —
-- a full mapping rather than a simple allow-list (unlike
-- never_notify_statuses / confirmed_statuses / delivered_statuses in
-- earlier migrations) because each status needs to land on a
-- *specific* column, not just a yes/no bucket.
--
-- Purely additive. Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS pipeline_id uuid REFERENCES pipelines(id) ON DELETE SET NULL;

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS status_stage_map jsonb NOT NULL DEFAULT '{}'::jsonb;
