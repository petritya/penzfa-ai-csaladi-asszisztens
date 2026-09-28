create schema if not exists private;

create or replace function private.is_family_user(p_family_id uuid)
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
      and fm.user_id = (select auth.uid())
      and fm.member_kind = 'active'
  );
$$;

revoke all on function private.is_family_user(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_family_user(uuid) to authenticated;

drop policy if exists families_select on public.families;
create policy families_select on public.families
for select to authenticated
using (created_by = (select auth.uid()) or private.is_family_user(id));

drop policy if exists family_members_select on public.family_members;
create policy family_members_select on public.family_members
for select to authenticated
using (private.is_family_user(family_id));

drop policy if exists user_settings_select on public.user_settings;
create policy user_settings_select on public.user_settings
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists items_select on public.items;
create policy items_select on public.items
for select to authenticated
using (private.is_family_user(family_id));

drop policy if exists reminders_select on public.reminders;
create policy reminders_select on public.reminders
for select to authenticated
using (
  exists (
    select 1 from public.items i
    where i.id = reminders.item_id
      and private.is_family_user(i.family_id)
  )
);

drop policy if exists pending_actions_select on public.pending_actions;
create policy pending_actions_select on public.pending_actions
for select to authenticated
using (actor_user_id = (select auth.uid()) and private.is_family_user(family_id));

drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log
for select to authenticated
using (private.is_family_user(family_id));

drop policy if exists user_settings_insert on public.user_settings;
create policy user_settings_insert on public.user_settings
for insert to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_settings_update on public.user_settings;
create policy user_settings_update on public.user_settings
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop function if exists public.is_family_user(uuid);
