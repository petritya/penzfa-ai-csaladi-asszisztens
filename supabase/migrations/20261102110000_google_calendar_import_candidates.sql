-- Fordított Google Naptár -> Pénzfa átvétel.
-- Alapértelmezetten kikapcsolva; minden átvétel külön jóváhagyást igényel.
alter table public.google_calendar_connections
  add column if not exists auto_import_enabled_at timestamptz,
  add column if not exists auto_import_last_scanned_at timestamptz,
  add column if not exists auto_import_error text;

create table if not exists public.google_calendar_import_candidates (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 1024),
  title text not null,
  notes text,
  due_date date not null,
  due_time time without time zone,
  google_created_at timestamptz not null,
  discovered_at timestamptz not null default now(),
  briefing_date date not null,
  expires_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','accepting','accepted','declined','expired')),
  push_attempted_at timestamptz,
  briefing_included_at timestamptz,
  item_id uuid,
  decided_at timestamptz,
  primary key (user_id, event_id)
);
create index if not exists google_calendar_import_pending_user_idx
  on public.google_calendar_import_candidates (user_id, expires_at)
  where status='pending';
create index if not exists google_calendar_import_pending_briefing_idx
  on public.google_calendar_import_candidates (user_id, briefing_date)
  where status='pending' and briefing_included_at is null;

alter table public.google_calendar_import_candidates enable row level security;
revoke all on public.google_calendar_import_candidates from public, anon, authenticated;
grant all on public.google_calendar_import_candidates to service_role;

-- Egy Cron-kör maximum egyszer / 4 perc alatt, függetlenül a HTTP hívásoktól.
create table if not exists public.google_calendar_import_runs (
  id integer primary key check(id=1),
  last_run_at timestamptz not null default '2000-01-01T00:00:00Z'
);
insert into public.google_calendar_import_runs(id) values(1) on conflict(id) do nothing;
alter table public.google_calendar_import_runs enable row level security;
revoke all on public.google_calendar_import_runs from public, anon, authenticated;
grant all on public.google_calendar_import_runs to service_role;
