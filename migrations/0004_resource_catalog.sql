-- Каталог ресурсов: несколько аккаунтов на провайдера, ресурсы отдельно от проектов, привязки многие-ко-многим.

-- 1. Подключения получают собственный id: аккаунтов одного провайдера может быть несколько
CREATE TABLE connections_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  account_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (provider, account_id)
);
INSERT INTO connections_new (id, provider, label, account_id, secret, meta, created_at)
  SELECT 'conn-' || provider, provider, label, account_id, secret, meta, created_at FROM connections;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;

-- 2. Ресурсы без project_id: аккаунт, происхождение и (для внешних) зашифрованный секрет
CREATE TABLE resources_new (
  id TEXT PRIMARY KEY,
  connection_id TEXT,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT,
  console_url TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  -- created: создан apphub; imported: найден в аккаунте; external: внешний (свой сервер)
  origin TEXT NOT NULL DEFAULT 'created',
  secret TEXT,
  created_at INTEGER NOT NULL
);
-- Тип ресурса начинается с провайдера (github.repo → github), а старые подключения получили id conn-<провайдер>
INSERT INTO resources_new (id, connection_id, type, kind, name, external_id, url, console_url, meta, origin, created_at)
  SELECT id, 'conn-' || substr(type, 1, instr(type, '.') - 1), type, kind, name, external_id, url, console_url, meta,
         'created', created_at
  FROM resources;

-- Привязки сохраняем во временную таблицу без внешних ключей: иначе удаление старой resources стёрло бы их каскадом
CREATE TABLE bindings_tmp AS SELECT project_id, id AS resource_id, kind AS role, created_at FROM resources;
DROP TABLE resources;
ALTER TABLE resources_new RENAME TO resources;
CREATE INDEX resources_connection ON resources (connection_id);

-- 3. Привязки ресурс ↔ проект с ролью (repo, service, database…) и параметрами привязки
CREATE TABLE project_resources (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, resource_id)
);
INSERT INTO project_resources (project_id, resource_id, role, created_at)
  SELECT project_id, resource_id, role, created_at FROM bindings_tmp;
DROP TABLE bindings_tmp;
CREATE INDEX project_resources_resource ON project_resources (resource_id);
