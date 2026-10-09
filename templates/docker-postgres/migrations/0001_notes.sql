-- Заметки. Приложение ходит в базу напрямую (роль postgres — владелец таблицы, RLS её не ограничивает),
-- а Data API Supabase для этой таблицы закрыт: RLS без политик запрещает доступ ролям anon и authenticated.
create table notes (
  id bigint generated always as identity primary key,
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);

alter table notes enable row level security;
