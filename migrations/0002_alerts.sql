-- Активные проблемы проектов: строка появляется, когда мониторинг находит проблему, и удаляется, когда она уходит.
-- По появлению и удалению отправляются уведомления — поэтому о длящейся проблеме не пишем повторно.
CREATE TABLE alerts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- Служебные значения apphub (например, время последней проверки).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
