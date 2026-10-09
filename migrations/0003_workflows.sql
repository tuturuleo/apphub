-- Экземпляр Cloudflare Workflow, который создаёт ресурсы проекта: по нему видно, жив ли процесс создания.
ALTER TABLE projects ADD COLUMN workflow_id TEXT;
