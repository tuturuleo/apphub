-- Секрет привязки: строка подключения проекта к общей базе в изолированном режиме (своя схема и пользователь).
ALTER TABLE project_resources ADD COLUMN secret TEXT;
