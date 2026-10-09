-- Связи внутри проекта: значение (выход) одного ресурса записывается в переменную другого.
-- Например, DATABASE_URL базы → переменная окружения сервиса Render.
CREATE TABLE wires (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  output TEXT NOT NULL,
  target_id TEXT NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  -- имя переменной у потребителя
  name TEXT NOT NULL,
  -- когда значение последний раз записано; NULL — ещё не записано
  applied_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, target_id, name)
);
CREATE INDEX wires_source ON wires (source_id);
