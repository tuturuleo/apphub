# %%PROJECT_NAME%%

Создано в AppHub по рецепту «Сайт + API + SQLite».

- `public/` — статический фронтенд
- `src/index.ts` — API на Cloudflare Workers (`/api/*`)
- `migrations/` — схема базы D1, применяется при каждом деплое

Деплой: push в `main` → GitHub Actions → Cloudflare.

Локально:

```bash
npm install
npm run types
npm run dev
```
