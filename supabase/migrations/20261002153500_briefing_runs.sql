create table if not exists public.briefing_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid not null references public.families(id) on delete cascade,
  briefing_date date not null,
  message text not null,
  sent_at timestamptz,
  status text not null default 'pending'
    check (status = any (array['pending'::text, 'sent'::text, 'failed'::text])),
  created_at timestamptz not null default now(),
  unique (user_id, briefing_date)
);

alter table public.briefing_runs enable row level security;

create index if not exists idx_briefing_runs_user_date
  on public.briefing_runs(user_id, briefing_date desc);
