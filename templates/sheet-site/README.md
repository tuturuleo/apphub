# %%PROJECT_NAME%%

Создано в AppHub по рецепту «Сайт из Google-таблицы».

Данные берутся из Google-таблицы (`site.config.json`: опубликованная по ссылке или приватная из Drive —
тогда сборка читает её ключом сервисного аккаунта из секрета `GOOGLE_SA_KEY`) и пересобираются по расписанию
(`.github/workflows/deploy.yml`), при каждом push и по кнопке «Run workflow» в Actions.

Локально: `npm run build`, затем откройте `dist/` любым статическим сервером.
