# apphub

Единое место для прототипов на бесплатных тарифах. Выбираешь рецепт — apphub создаёт репозиторий,
базу и сервис у провайдеров, связывает их секретами и настраивает деплой через GitHub Actions.
Дальше `git push` → автодеплой, а статусы всех частей проекта видны на одной странице.

Сам apphub тоже живёт бесплатно: Cloudflare Worker + D1.

## Рецепты

| Рецепт | Что создаётся | Провайдеры |
|---|---|---|
| Сайт + API + SQLite | репо, Worker со статикой и `/api/*`, база D1, деплой с миграциями | GitHub, Cloudflare |
| Сайт из Google-таблицы | публичное репо, GitHub Pages, пересборка по расписанию из CSV | GitHub |

Рецепт = шаблон кода в `templates/<id>` + описание в `src/worker/recipes/<id>.ts`.
В шаблонах `%%VAR%%` подставляется при создании проекта, `_github` и `_gitignore` становятся `.github` и `.gitignore`.

## Локальный запуск

```bash
npm install
npm run setup:local   # .dev.vars с ключом шифрования + миграции локальной D1
npm run dev           # http://localhost:5173
```

Локально проверка доступа отключена (`DEV_ALLOW_NO_AUTH=true` в `.dev.vars`), но подключения и рецепты
работают с настоящими API GitHub и Cloudflare — проекты создаются по-настоящему.

## Деплой своего экземпляра

```bash
npx wrangler d1 create apphub                    # database_id → wrangler.jsonc
npx wrangler d1 migrations apply DB --remote
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
npm run deploy
```

Затем закройте доступ через Cloudflare Access (бесплатно до 50 пользователей):
Workers & Pages → apphub → Settings → Domains & Routes → workers.dev → включить Cloudflare Access.
Скопируйте Audience (AUD) и домен команды (`<team>.cloudflareaccess.com`) в `vars` в `wrangler.jsonc`
и задеплойте ещё раз. Без этих переменных API отвечает 503 — apphub не бывает открытым случайно.

## Безопасность

- Токены провайдеров шифруются AES-256-GCM ключом `ENCRYPTION_KEY` и не возвращаются в интерфейс.
- Токен Cloudflare кладётся в секреты каждого созданного репозитория, чтобы Actions могли деплоить.
  Давайте ему только права из инструкции на странице «Подключения».
- «Убрать из apphub» не удаляет ресурсы у провайдеров.

## Структура

```
src/worker/            API на Hono
  providers/           клиенты GitHub и Cloudflare, каталог провайдеров
  recipes/             рецепты и загрузка шаблонов
  engine.ts            выполнение рецептов, статусы ресурсов
  sealed-box.ts        шифрование секретов GitHub Actions (libsodium sealed box)
src/web/               интерфейс на React
templates/             шаблоны проектов, встраиваются в бандл Worker
migrations/            схема D1 самого apphub
```

## Дальше

- Supabase (Postgres без своего сервера) и Render (Docker) как провайдеры, рецепты с ними
- Cron: периодическая проверка статусов и алерты в Telegram
- Удаление ресурсов у провайдеров вместе с проектом
