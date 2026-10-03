-- A meghívott auth felhasználó azonosítójának tárolása.
-- Az e-mail a meghívás elfogadása után törölhető a publikus üzleti táblából.

alter table public.family_owner_invitations
  add column if not exists invited_user_id uuid references auth.users(id) on delete restrict;

alter table public.family_owner_invitations
  alter column email drop not null;

create index if not exists family_owner_invitations_invited_user_idx
  on public.family_owner_invitations (invited_user_id)
  where status = 'pending' and invited_user_id is not null;
