# apphub

Единое место для прототипов на бесплатных тарифах. Выбираешь рецепт — apphub создаёт репозиторий,
базу и сервис у провайдеров, связывает их секретами и настраивает деплой через GitHub Actions.
Дальше `git push` → автодеплой, а статусы всех частей проекта видны на одной странице.

Сам apphub тоже живёт бесплатно: Cloudflare Worker + D1.

## Рецепты

| Рецепт | Что создаётся | Провайдеры |
|---|---|---|
| Сайт + API + SQLite | репо, Worker со статикой и `/api/*`, база D1, деплой с миграциями | GitHub, Cloudflare |
| Сайт + Postgres | проект Supabase (Postgres + анонимный вход + RLS), Pages, миграции через Supabase CLI в Actions | GitHub, Supabase |
| Сайт из Google-таблицы | публичное репо, GitHub Pages, пересборка по расписанию из CSV | GitHub |

Рецепт = шаблон кода в `templates/<id>` + описание в `src/worker/recipes/<id>.ts`.
В шаблонах `%%VAR%%` подставляется при создании проекта, `_github` и `_gitignore` становятся `.github` и `.gitignore`.

## Локальный запуск

```bash
npm install
npm run setup:local   # .dev.vars с ключом шифрования + миграции локальной D1
npm run dev           # http://localhost:5179
```

Локально проверка доступа отключена (`DEV_ALLOW_NO_AUTH=true` в `.dev.vars`), но подключения и рецепты
работают с настоящими API GitHub и Cloudflare — проекты создаются по-настоящему.

## MCP: управление через Claude

apphub отдаёт свои операции как MCP-сервер по адресу `/mcp` (Streamable HTTP, без сессий):

| Инструмент | Что делает |
|---|---|
| `list_recipes` | рецепты, их параметры и недостающие подключения |
| `list_connections` | подключённые провайдеры (без токенов) |
| `list_projects` / `get_project` | проекты; ресурсы со статусами, запуски Actions с логами, журнал |
| `create_project` | создаёт проект по рецепту и ждёт окончания создания |
| `get_project_files` | список файлов репозитория проекта или содержимое выбранных |
| `update_project_files` | один коммит: создать, заменить, удалить файлы; push запускает деплой |
| `deploy_project` | запускает деплой в GitHub Actions |
| `wake_resource` | будит уснувший ресурс (Supabase) |

Удалять через MCP нельзя. Токены провайдеров подключаются только в интерфейсе.

**Claude Code, локально.** В репозитории лежит `.mcp.json` с `http://localhost:5179/mcp`: запустите `npm run dev`
и откройте Claude Code в этой папке — он предложит подключить сервер `apphub`. В другом проекте:

```bash
claude mcp add --transport http apphub http://localhost:5179/mcp
```

**Задеплоенный apphub.** `/mcp` закрыт тем же Cloudflare Access. Для Claude Code создайте Access service token
(Zero Trust → Access → Service Auth), добавьте в приложение политику Service Auth с этим токеном и подключите:

```bash
claude mcp add --transport http apphub https://apphub.<поддомен>.workers.dev/mcp \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

Коннекторы claude.ai требуют OAuth — это следующий шаг.

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

Создание идёт в два запроса: `POST /api/projects` записывает проект, `POST /api/projects/:id/provision`
создаёт ресурсы (Supabase поднимает базу до нескольких минут), а интерфейс тем временем опрашивает журнал.

## Безопасность

- Токены провайдеров шифруются AES-256-GCM ключом `ENCRYPTION_KEY` и не возвращаются в интерфейс.
- Токен Cloudflare кладётся в секреты каждого созданного репозитория, чтобы Actions могли деплоить.
  Давайте ему только права из инструкции на странице «Подключения».
- Токен Supabase остаётся в apphub. В репозиторий уходит только строка подключения к базе конкретного проекта.
- «Убрать из apphub» не удаляет ресурсы у провайдеров.

## Структура

```
src/worker/            API на Hono
  providers/           клиенты GitHub и Cloudflare, каталог провайдеров
  recipes/             рецепты и загрузка шаблонов
  engine.ts            выполнение рецептов, статусы ресурсов
  service.ts           операции с проектами, общие для REST и MCP
  mcp.ts               MCP-сервер
  sealed-box.ts        шифрование секретов GitHub Actions (libsodium sealed box)
src/web/               интерфейс на React
templates/             шаблоны проектов, встраиваются в бандл Worker
migrations/            схема D1 самого apphub
```

## Дальше

1. **Render (Docker)** — сервисы на любом языке, рецепт «Docker-сервис + Postgres».
2. **LLM-коннектор**, продолжение:
   - OAuth для MCP, чтобы подключать apphub коннектором в claude.ai.
   - Чат в интерфейсе apphub на Claude API (нужен API-ключ): подбирает рецепт, создаёт проект, разбирает упавший деплой.
3. **Cron и алерты** — периодическая проверка статусов, уведомления в Telegram
   (упал деплой, Supabase уснул, расписание в репо отключено).
4. Удаление ресурсов у провайдеров вместе с проектом.
