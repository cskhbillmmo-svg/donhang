create table if not exists public.app_store (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_store enable row level security;

drop policy if exists "app_store_select" on public.app_store;
drop policy if exists "app_store_insert" on public.app_store;
drop policy if exists "app_store_update" on public.app_store;

create policy "app_store_select"
on public.app_store
for select
to anon
using (true);

create policy "app_store_insert"
on public.app_store
for insert
to anon
with check (true);

create policy "app_store_update"
on public.app_store
for update
to anon
using (true)
with check (true);
