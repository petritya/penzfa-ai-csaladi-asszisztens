-- Opt-in automatikus küldés, kizárólag az engedélyezés UTÁN rögzített ügyekkel.
alter table public.google_calendar_connections
  add column if not exists auto_export_enabled_at timestamptz,
  add column if not exists auto_export_error text;

-- Kizárólag az Edge Function service_role kapcsolata hívhatja.
-- SECURITY INVOKER: a funkció nem emel jogosultságot.
create or replace function public.google_calendar_pending_auto_exports(p_limit integer default 5)
returns table (
  user_id uuid,
  item_id uuid,
  event_title text,
  event_notes text,
  event_date date,
  encrypted_refresh_token text
)
language sql
security invoker
set search_path = ''
as $$
  select
    c.user_id, i.id, i.title, i.notes, i.due_date, c.refresh_token_encrypted
  from public.google_calendar_connections c
  join public.items i
    on i.responsible_user_id = c.user_id
  join public.family_members fm
    on fm.user_id = c.user_id and fm.family_id = i.family_id and fm.member_kind = 'active'
  where c.auto_export_enabled_at is not null
    and c.auto_export_error is null
    and i.created_at >= c.auto_export_enabled_at
    and i.status = 'open'
    and i.due_date is not null
    and i.due_time is null
    and not exists (
      select 1 from public.google_calendar_exports e
      where e.user_id = c.user_id and e.item_id = i.id
    )
  order by i.created_at, i.id
  limit greatest(1, least(coalesce(p_limit, 5), 10));
$$;

revoke all on function public.google_calendar_pending_auto_exports(integer)
  from public, anon, authenticated;
grant execute on function public.google_calendar_pending_auto_exports(integer)
  to service_role;

create index if not exists items_calendar_auto_candidates_idx
  on public.items (responsible_user_id, created_at)
  where status = 'open' and due_date is not null and due_time is null;
