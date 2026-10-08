# %%PROJECT_NAME%%

Создано в apphub по рецепту «Сайт + Postgres».

- `public/` — статический сайт, публикуется на GitHub Pages
- `supabase/migrations/` — схема базы; новые миграции применяются при каждом деплое
- данные защищены правилами RLS прямо в базе — свой сервер не нужен

Новая миграция: добавьте файл `supabase/migrations/<YYYYMMDDHHMMSS>_<имя>.sql` и сделайте push.

Строка подключения к базе лежит в секрете `SUPABASE_DB_URL`. Пароль можно сменить в панели Supabase
(Project Settings → Database), после чего обновите секрет.
