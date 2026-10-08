# %%PROJECT_NAME%%

Создано в apphub по рецепту «Сайт из Google-таблицы».

Данные берутся из опубликованной таблицы (`site.config.json`) и пересобираются по расписанию
(`.github/workflows/deploy.yml`), при каждом push и по кнопке «Run workflow» в Actions.

Локально: `npm run build`, затем откройте `dist/` любым статическим сервером.
