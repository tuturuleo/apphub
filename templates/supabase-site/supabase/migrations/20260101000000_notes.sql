-- Заметки пользователя. Доступ из браузера ограничен правилами RLS: каждый видит только свои строки.
create table public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

grant select, insert, delete on public.notes to authenticated;

create policy "notes: читать свои" on public.notes
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "notes: добавлять свои" on public.notes
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "notes: удалять свои" on public.notes
  for delete to authenticated using ((select auth.uid()) = user_id);
