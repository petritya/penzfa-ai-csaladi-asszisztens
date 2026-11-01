-- Google Naptár OAuth kapcsolatok; minden adatot csak a szerveroldali Edge Function kezel.
create table if not exists public.google_calendar_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  return_origin text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists google_calendar_oauth_states_expiry_idx
  on public.google_calendar_oauth_states (expires_at);

create table if not exists public.google_calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token_encrypted text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_calendar_oauth_states enable row level security;
alter table public.google_calendar_connections enable row level security;

-- Sem anon, sem authenticated nem olvashat OAuth állapotot vagy titkos tokent.
-- Ezekhez csak a service_role-lal hitelesített szerveroldali függvény fér hozzá.
revoke all on public.google_calendar_oauth_states from public, anon, authenticated;
revoke all on public.google_calendar_connections from public, anon, authenticated;
