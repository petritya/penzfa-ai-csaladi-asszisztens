-- Rövid életű, egyszer felhasználható OAuth befejezési jegyek.
-- A tényleges kapcsolatot kizárólag ugyanaz a bejelentkezett Pénzfa-fiók véglegesítheti.
create table if not exists public.google_calendar_oauth_completions (
  ticket_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  refresh_token_encrypted text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists google_calendar_oauth_completions_expiry_idx
  on public.google_calendar_oauth_completions (expires_at);
alter table public.google_calendar_oauth_completions enable row level security;
revoke all on public.google_calendar_oauth_completions from public, anon, authenticated;
