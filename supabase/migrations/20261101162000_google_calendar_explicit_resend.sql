-- Megőrizzük az egyszeri automatikus küldés naplóját;
-- csak kifejezett, ellenőrzött kézi újraküldés növeli a számlálót.
alter table public.google_calendar_exports
  add column if not exists resend_count integer not null default 0
    check (resend_count >= 0);
