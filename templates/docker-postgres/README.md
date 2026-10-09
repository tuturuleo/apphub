# %%PROJECT_NAME%%

Создано в apphub по рецепту «Docker-сервис + Postgres».

- `Dockerfile` — сборка образа; Render собирает его при каждом push в `main`
- `app/` — API на FastAPI и страница `app/static/index.html`
- `migrations/` — схема базы; новые файлы применяются при старте приложения

Приложение можно заменить на любой язык: Render нужен `Dockerfile`, сервис должен слушать порт из `PORT`
и отвечать на `/health`. Строка подключения к базе приходит в `DATABASE_URL` (переменные окружения Render).

Локально:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
DATABASE_URL=postgresql://... uvicorn app.main:app --reload
```

Бесплатный инстанс Render засыпает через 15 минут без запросов — первый запрос после сна идёт около минуты.
