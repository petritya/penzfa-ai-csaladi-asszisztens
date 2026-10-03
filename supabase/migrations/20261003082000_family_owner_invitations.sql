-- Pénzfa – opcionális második ügygazda meghívásának alapja.
-- Az e-mail csak a meghívási folyamathoz kell; a családi ügyek továbbra is alias/nevek alapján működnek.

create table public.family_owner_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'cancelled')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  accepted_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  cancelled_at timestamptz
);

create unique index family_owner_invitations_one_pending_per_family
  on public.family_owner_invitations (family_id)
  where status = 'pending';

create unique index family_owner_invitations_pending_email_uidx
  on public.family_owner_invitations (family_id, lower(email))
  where status = 'pending';

alter table public.family_owner_invitations enable row level security;

create policy family_owner_invitations_select
on public.family_owner_invitations
for select to authenticated
using (private.is_family_user(family_id));

-- Írás csak a Core Edge Functionön keresztül történik service role-lal.
