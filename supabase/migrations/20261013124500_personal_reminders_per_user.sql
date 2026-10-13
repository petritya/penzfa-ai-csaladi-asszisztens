alter table public.reminders
  add column if not exists user_id uuid;

update public.reminders r
set user_id = i.responsible_user_id
from public.items i
where i.id = r.item_id
  and r.user_id is null;

alter table public.reminders
  alter column user_id set not null;

alter table public.reminders
  drop constraint if exists reminders_item_id_key;

drop index if exists public.reminders_item_id_key;

create unique index if not exists reminders_item_user_id_key
  on public.reminders(item_id, user_id);

create index if not exists reminders_user_id_idx
  on public.reminders(user_id);

alter table public.reminders
  add constraint reminders_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
