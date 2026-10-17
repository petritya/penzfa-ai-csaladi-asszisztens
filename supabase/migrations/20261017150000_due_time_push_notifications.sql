-- Pontos időpontú ügyek eseménykori pushértesítése.
-- Egyetlen jelző védi a percenkénti cron párhuzamos futásait a duplikálástól.
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS due_push_sent_key text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS items_due_time_push_idx
  ON public.items (due_date, due_time)
  WHERE status = 'open'
    AND due_date IS NOT NULL
    AND due_time IS NOT NULL
    AND responsible_user_id IS NOT NULL;

-- A dátum, idő vagy felelős módosításakor az új esedékesség ismét jelezhető.
-- A szokásos feladatfrissítéshez nem kell külön Core- vagy klienskód.
CREATE OR REPLACE FUNCTION private.reset_due_push_sent_key_on_item_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (NEW.due_date, NEW.due_time, NEW.responsible_user_id)
     IS DISTINCT FROM
     (OLD.due_date, OLD.due_time, OLD.responsible_user_id) THEN
    NEW.due_push_sent_key := '';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS items_reset_due_push_sent_key ON public.items;
CREATE TRIGGER items_reset_due_push_sent_key
  BEFORE UPDATE ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION private.reset_due_push_sent_key_on_item_change();
