-- Google Naptárba történő KIKÜLDÉS helyi, tartós nyilvántartása.
-- A Google-ből való törlés nem törli a Pénzfa naplóbejegyzését.
-- A küldés megkezdésekor foglalunk helyet. A "sending" állapot bizonytalan:
-- önműködő újrapróbálás tilos (pl. válasz elveszett, de a Google létrehozta).
create table if not exists public.google_calendar_exports (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  event_id text not null,
  status text not null default 'sending' check (status in ('sending', 'sent')),
  first_attempted_at timestamptz not null default now(),
  exported_at timestamptz,
  primary key (user_id, item_id),
  constraint google_calendar_exports_sent_at_check
    check (status <> 'sent' or exported_at is not null)
);

comment on table public.google_calendar_exports is
  'Egyszeri Google Naptár export napló: a Google esemény későbbi törlése nem enged újraküldést.';

alter table public.google_calendar_exports enable row level security;
revoke all on public.google_calendar_exports from public, anon, authenticated;
-- A tábla csak a biztonságosan hitelesített Edge Function service_role kapcsolatán át érhető el.
