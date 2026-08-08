-- ============================================================
-- 038_dropi_sync_lock.sql — prevent overlapping Dropi syncs
--
-- The manual "Sync now" button and the recurring cron can both target
-- the same account. Without a lock, two syncs running at the same
-- moment can each read the same pre-change order status and both
-- decide "this changed, notify the customer" — sending the same
-- WhatsApp message twice. `syncing` is a simple claim flag: a sync
-- only proceeds if it can atomically flip it false→true; whoever
-- loses the race exits immediately instead of doing any work.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS syncing BOOLEAN NOT NULL DEFAULT false;

-- Heals a sync that crashed mid-run (process killed, deploy restart)
-- and left `syncing` stuck true forever, which would otherwise block
-- every future sync for that account permanently.
CREATE OR REPLACE FUNCTION public.claim_dropi_sync(p_account_id UUID)
RETURNS BOOLEAN AS $$
  UPDATE dropi_config
  SET syncing = true
  WHERE account_id = p_account_id
    AND is_active = true
    AND (syncing = false OR updated_at < now() - interval '15 minutes')
  RETURNING true;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_dropi_sync(UUID) TO service_role;
