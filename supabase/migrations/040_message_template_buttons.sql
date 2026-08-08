-- ============================================================
-- 040_message_template_buttons.sql — render sent template buttons
--
-- A sent template message only stored `template_name` + the rendered
-- body text — the inbox bubble showed a "Plantilla" badge and the
-- text, but never the template's own buttons (Quick Reply / URL /
-- Phone / Copy Code), so an agent couldn't see what options the
-- customer was actually offered without opening Settings → Templates.
-- `template_buttons` snapshots the template's buttons (from
-- message_templates.buttons) at send time, mirroring how
-- `interactive_payload` already lets an interactive-message bubble
-- re-render its buttons/rows.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS template_buttons JSONB;
