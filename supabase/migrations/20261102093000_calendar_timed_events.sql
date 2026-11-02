-- Időpontra ütemezett ügyek is automatikusan átadhatók.
-- Az időzóna a felhasználó meglévő user_settings.timezone beállításából jön.
-- A függvény kimenete megváltozik, ezért a signature újrakészül.
drop function if exists public.google_calendar_pending_auto_exports(integer);

create function public.google_calendar_pending_auto_exports(p_limit integer default 5)
returns table (
  user_id uuid,
  item_id uuid,
  event_title text,
  event_notes text,
  event_date date,
  event_time time without time zone,
  event_timezone text,
  event_created_at timestamptz,
  event_updated_at timestamptz,
  encrypted_refresh_token text
)
language sql
security invoker
set search_path = ''
as $$
  select
    c.user_id,
    i.id,
    i.title,
    i.notes,
    i.due_date,
    i.due_time,
    coalesce(nullif(us.timezone, ''), 'Europe/Budapest'),
    i.created_at,
    i.updated_at,
    c.refresh_token_encrypted
  from public.google_calendar_connections c
  join public.items i
    on i.responsible_user_id = c.user_id
  join public.family_members fm
    on fm.user_id = c.user_id and fm.family_id = i.family_id and fm.member_kind = 'active'
  left join public.user_settings us
    on us.user_id = c.user_id
  where c.auto_export_enabled_at is not null
    and c.auto_export_error is null
    and i.created_at >= c.auto_export_enabled_at
    and i.status = 'open'
    and i.due_date is not null
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
