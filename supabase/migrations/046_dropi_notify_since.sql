-- ============================================================
-- 046_dropi_notify_since.sql
--
-- Fixes a gap in the "never notify on the first sync of a brand-new
-- row" safety rule (see sync.ts header comment): that rule was written
-- to stop a first-time activation from blasting messages to an entire
-- historical backlog, but it has the side effect of ALSO silencing the
-- very first automation (e.g. "Confirmación de pedido") for orders
-- that are genuinely brand new — an order the CRM has never seen
-- before looks identical to a stale historical one from the sync's
-- point of view.
--
-- This column lets the account draw an explicit line: orders created
-- in Dropi (`dropi_created_at`) at or after `notify_since` are treated
-- as notify-worthy even on the CRM's first sight of them; orders
-- created before it are treated as historical backlog, same as today
-- (never notified on first sight). NULL (the default) preserves
-- today's fully-safe behaviour — nothing changes until the account
-- explicitly sets a cutoff in Settings → Dropi.
--
-- Purely additive. Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE dropi_config
  ADD COLUMN IF NOT EXISTS notify_since timestamptz DEFAULT NULL;
