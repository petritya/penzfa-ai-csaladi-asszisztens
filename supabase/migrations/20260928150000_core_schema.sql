-- Pénzfa – AI családi asszisztens MVP
-- Core 7 minimum adatmodell. Nincs dokumentumtárolás, bank, EESZT, webshop,
-- multi-agent, queue vagy más későbbi modul.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid references auth.users(id) on delete restrict,
  display_name text not null,
  member_kind text not null check (member_kind in ('active', 'managed')),
  created_at timestamptz not null default now(),
  constraint family_member_user_shape check (
    (member_kind = 'active' and user_id is not null)
    or
    (member_kind = 'managed' and user_id is null)
  )
);

create unique index family_members_family_user_uidx
  on public.family_members (family_id, user_id)
  where user_id is not null;

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'Europe/Budapest',
  briefing_enabled boolean not null default true,
  briefing_time time not null default '07:00',
  notify_partner_on_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  subject_member_id uuid references public.family_members(id) on delete restrict,
  responsible_user_id uuid references auth.users(id) on delete restrict,
  item_type text not null check (item_type in ('task', 'event', 'deadline')),
  title text not null,
  notes text,
  due_date date,
  due_time time,
  status text not null default 'open' check (status in ('open', 'done', 'deleted')),
  created_by uuid not null references auth.users(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index items_family_status_due_idx
  on public.items (family_id, status, due_date);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null unique references public.items(id) on delete cascade,
  first_reminder_at timestamptz,
  specific_push_at timestamptz,
  next_notification_at timestamptz,
  follow_up_step smallint not null default 0 check (follow_up_step >= 0),
  last_sent_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reminders_next_notification_idx
  on public.reminders (next_notification_at)
  where enabled = true and next_notification_at is not null;

create table public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  intent text not null check (intent in ('update', 'complete', 'delete')),
  target_item_id uuid references public.items(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index pending_actions_actor_status_idx
  on public.pending_actions (actor_user_id, status, expires_at);

create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  item_id uuid references public.items(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_log_family_created_idx
  on public.activity_log (family_id, created_at desc);

create trigger families_set_updated_at
before update on public.families
for each row execute function public.set_updated_at();

create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

create trigger items_set_updated_at
before update on public.items
for each row execute function public.set_updated_at();

create trigger reminders_set_updated_at
before update on public.reminders
for each row execute function public.set_updated_at();

create or replace function public.is_family_user(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.family_members fm
    where fm.family_id = p_family_id
      and fm.user_id = auth.uid()
      and fm.member_kind = 'active'
  );
$$;

revoke all on function public.is_family_user(uuid) from public;
grant execute on function public.is_family_user(uuid) to authenticated;

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.user_settings enable row level security;
alter table public.items enable row level security;
alter table public.reminders enable row level security;
alter table public.pending_actions enable row level security;
alter table public.activity_log enable row level security;

create policy families_select on public.families
for select to authenticated
using (created_by = auth.uid() or public.is_family_user(id));

create policy family_members_select on public.family_members
for select to authenticated
using (public.is_family_user(family_id));

create policy user_settings_select on public.user_settings
for select to authenticated
using (user_id = auth.uid());

create policy items_select on public.items
for select to authenticated
using (public.is_family_user(family_id));

create policy reminders_select on public.reminders
for select to authenticated
using (
  exists (
    select 1 from public.items i
    where i.id = reminders.item_id
      and public.is_family_user(i.family_id)
  )
);

create policy pending_actions_select on public.pending_actions
for select to authenticated
using (actor_user_id = auth.uid() and public.is_family_user(family_id));

create policy activity_log_select on public.activity_log
for select to authenticated
using (public.is_family_user(family_id));

create policy user_settings_insert on public.user_settings
for insert to authenticated
with check (user_id = auth.uid());

create policy user_settings_update on public.user_settings
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- A Core üzleti adatok írása szándékosan NEM kap közvetlen kliens policy-t.
-- Létrehozás/módosítás/lezárás/törlés Edge Functionön keresztül történik.
