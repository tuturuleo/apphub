// Доступ к D1: строки таблиц ↔ общие типы.
import type {
  BoundResource,
  CatalogResource,
  Connection,
  Project,
  ProjectAlert,
  ProjectEvent,
  ProjectStatus,
  ProviderId,
  Resource,
  ResourceKind,
  ResourceOrigin,
  ResourceType,
  Wire,
} from "../shared/types";
import { decrypt, encrypt } from "./crypto";
import type { AppEnv } from "./env";

interface ConnectionRow {
  id: string;
  provider: ProviderId;
  label: string;
  account_id: string;
  secret: string;
  meta: string;
  created_at: number;
}

interface ProjectRow {
  id: string;
  name: string;
  recipe_id: string;
  params: string;
  status: ProjectStatus;
  error: string | null;
  created_at: number;
}

interface ResourceRow {
  id: string;
  connection_id: string | null;
  type: ResourceType;
  kind: ResourceKind;
  name: string;
  external_id: string;
  url: string | null;
  console_url: string | null;
  meta: string;
  origin: ResourceOrigin;
  created_at: number;
}

interface BindingRow extends ResourceRow {
  role: string;
  binding_meta: string;
}

interface EventRow {
  id: number;
  level: "info" | "error";
  message: string;
  created_at: number;
}

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  accountId: r.account_id,
  meta: JSON.parse(r.meta),
  createdAt: r.created_at,
});

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  recipeId: r.recipe_id,
  params: JSON.parse(r.params),
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
});

const toResource = (r: ResourceRow): Resource => ({
  id: r.id,
  connectionId: r.connection_id,
  type: r.type,
  kind: r.kind,
  name: r.name,
  externalId: r.external_id,
  url: r.url,
  consoleUrl: r.console_url,
  meta: JSON.parse(r.meta),
  origin: r.origin,
  createdAt: r.created_at,
});

const toBound = (r: BindingRow): BoundResource => ({
  ...toResource(r),
  role: r.role,
  binding: JSON.parse(r.binding_meta),
});

export type NewResource = Omit<Resource, "id" | "createdAt">;

export class Store {
  constructor(readonly env: AppEnv) {}

  private get db() {
    return this.env.DB;
  }

  // --- подключения (аккаунты) ---

  async listConnections(): Promise<Connection[]> {
    const { results } = await this.db.prepare("SELECT * FROM connections ORDER BY created_at").all<ConnectionRow>();
    return results.map(toConnection);
  }

  private async withToken(row: ConnectionRow): Promise<Connection & { token: string }> {
    try {
      return { ...toConnection(row), token: await decrypt(row.secret, this.env.ENCRYPTION_KEY) };
    } catch {
      // например, сменился ENCRYPTION_KEY
      throw new Error(`Не удалось расшифровать токен ${row.provider} (${row.label}) — подключите его заново`);
    }
  }

  async getConnectionById(id: string): Promise<(Connection & { token: string }) | null> {
    const row = await this.db.prepare("SELECT * FROM connections WHERE id = ?").bind(id).first<ConnectionRow>();
    return row ? this.withToken(row) : null;
  }

  /** Аккаунт провайдера по умолчанию — подключённый первым. */
  async defaultConnection(provider: ProviderId): Promise<(Connection & { token: string }) | null> {
    const row = await this.db
      .prepare("SELECT * FROM connections WHERE provider = ? ORDER BY created_at LIMIT 1")
      .bind(provider)
      .first<ConnectionRow>();
    return row ? this.withToken(row) : null;
  }

  /** Сохраняет аккаунт: тот же аккаунт провайдера обновляется, новый — добавляется. Возвращает id. */
  async saveConnection(c: Omit<Connection, "id" | "createdAt">, token: string): Promise<string> {
    const secret = await encrypt(token, this.env.ENCRYPTION_KEY);
    const row = await this.db
      .prepare(
        `INSERT INTO connections (id, provider, label, account_id, secret, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, account_id) DO UPDATE SET
           label = excluded.label, secret = excluded.secret, meta = excluded.meta
         RETURNING id`,
      )
      .bind(crypto.randomUUID(), c.provider, c.label, c.accountId, secret, JSON.stringify(c.meta), Date.now())
      .first<{ id: string }>();
    return row!.id;
  }

  /** Заменяет токен существующего аккаунта (например, истёк). */
  async replaceConnectionToken(id: string, c: Omit<Connection, "id" | "createdAt">, token: string): Promise<void> {
    const secret = await encrypt(token, this.env.ENCRYPTION_KEY);
    await this.db
      .prepare("UPDATE connections SET label = ?, account_id = ?, secret = ?, meta = ? WHERE id = ?")
      .bind(c.label, c.accountId, secret, JSON.stringify(c.meta), id)
      .run();
  }

  async deleteConnection(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM connections WHERE id = ?").bind(id).run();
  }

  // --- projects ---

  async listProjects(): Promise<Project[]> {
    const { results } = await this.db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all<ProjectRow>();
    return results.map(toProject);
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
    return row ? toProject(row) : null;
  }

  async getProjectByName(name: string): Promise<Project | null> {
    const row = await this.db.prepare("SELECT * FROM projects WHERE name = ?").bind(name).first<ProjectRow>();
    return row ? toProject(row) : null;
  }

  async createProject(p: Pick<Project, "name" | "recipeId" | "params">): Promise<Project> {
    const project: Project = {
      id: crypto.randomUUID(),
      ...p,
      status: "pending",
      error: null,
      createdAt: Date.now(),
    };
    await this.db
      .prepare("INSERT INTO projects (id, name, recipe_id, params, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(project.id, project.name, project.recipeId, JSON.stringify(project.params), project.status, project.createdAt)
      .run();
    return project;
  }

  /** Переводит проект из pending в provisioning; false, если создание уже кто-то запустил. */
  async claimProject(id: string): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE projects SET status = 'provisioning' WHERE id = ? AND status = 'pending'")
      .bind(id)
      .run();
    return res.meta.changes === 1;
  }

  async getResource(id: string): Promise<Resource | null> {
    const row = await this.db.prepare("SELECT * FROM resources WHERE id = ?").bind(id).first<ResourceRow>();
    return row ? toResource(row) : null;
  }

  async setWorkflowId(id: string, workflowId: string): Promise<void> {
    await this.db.prepare("UPDATE projects SET workflow_id = ? WHERE id = ?").bind(workflowId, id).run();
  }

  async getWorkflowId(id: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT workflow_id FROM projects WHERE id = ?")
      .bind(id)
      .first<{ workflow_id: string | null }>();
    return row?.workflow_id ?? null;
  }

  async lastEventAt(projectId: string): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT MAX(created_at) AS at FROM events WHERE project_id = ?")
      .bind(projectId)
      .first<{ at: number | null }>();
    return row?.at ?? null;
  }

  async setProjectStatus(id: string, status: ProjectStatus, error: string | null = null): Promise<void> {
    await this.db.prepare("UPDATE projects SET status = ?, error = ? WHERE id = ?").bind(status, error, id).run();
  }

  async deleteProject(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM alerts WHERE project_id = ?").bind(id),
      this.db.prepare("DELETE FROM events WHERE project_id = ?").bind(id),
      // сами ресурсы остаются в каталоге — их судьбу решает вызывающий (destroyProject)
      this.db.prepare("DELETE FROM wires WHERE project_id = ?").bind(id),
      this.db.prepare("DELETE FROM project_resources WHERE project_id = ?").bind(id),
      this.db.prepare("DELETE FROM projects WHERE id = ?").bind(id),
    ]);
  }

  // --- ресурсы и привязки ---

  /** Ресурсы проекта с ролями привязки. */
  async listResources(projectId: string): Promise<BoundResource[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.*, pr.role, pr.meta AS binding_meta FROM resources r
         JOIN project_resources pr ON pr.resource_id = r.id
         WHERE pr.project_id = ? ORDER BY pr.created_at`,
      )
      .bind(projectId)
      .all<BindingRow>();
    return results.map(toBound);
  }

  /** Все привязки — для сводок по всем проектам. */
  async listBindings(): Promise<(BoundResource & { projectId: string })[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.*, pr.role, pr.meta AS binding_meta, pr.project_id FROM resources r
         JOIN project_resources pr ON pr.resource_id = r.id ORDER BY pr.created_at`,
      )
      .all<BindingRow & { project_id: string }>();
    return results.map((r) => ({ ...toBound(r), projectId: r.project_id }));
  }

  /** Каталог: все ресурсы с аккаунтом и проектами, к которым они привязаны. */
  async listCatalog(): Promise<CatalogResource[]> {
    const [{ results: rows }, { results: links }] = await Promise.all([
      this.db
        .prepare(
          `SELECT r.*, c.label AS account, r.secret IS NOT NULL AS has_secret FROM resources r
           LEFT JOIN connections c ON c.id = r.connection_id ORDER BY r.created_at DESC`,
        )
        .all<ResourceRow & { account: string | null; has_secret: number }>(),
      this.db
        .prepare(
          `SELECT pr.resource_id, pr.role, p.id, p.name FROM project_resources pr
           JOIN projects p ON p.id = pr.project_id ORDER BY pr.created_at`,
        )
        .all<{ resource_id: string; role: string; id: string; name: string }>(),
    ]);
    return rows.map((r) => ({
      ...toResource(r),
      account: r.account,
      hasSecret: r.has_secret === 1,
      projects: links.filter((l) => l.resource_id === r.id).map(({ id, name, role }) => ({ id, name, role })),
    }));
  }

  async findResource(type: ResourceType, connectionId: string | null, externalId: string): Promise<Resource | null> {
    const row = await this.db
      .prepare("SELECT * FROM resources WHERE type = ? AND connection_id IS ? AND external_id = ?")
      .bind(type, connectionId, externalId)
      .first<ResourceRow>();
    return row ? toResource(row) : null;
  }

  async addResource(r: NewResource, secret: string | null = null): Promise<Resource> {
    const resource: Resource = { ...r, id: crypto.randomUUID(), createdAt: Date.now() };
    await this.db
      .prepare(
        `INSERT INTO resources
           (id, connection_id, type, kind, name, external_id, url, console_url, meta, origin, secret, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        resource.id,
        resource.connectionId,
        resource.type,
        resource.kind,
        resource.name,
        resource.externalId,
        resource.url,
        resource.consoleUrl,
        JSON.stringify(resource.meta),
        resource.origin,
        secret === null ? null : await encrypt(secret, this.env.ENCRYPTION_KEY),
        resource.createdAt,
      )
      .run();
    return resource;
  }

  /** Расшифрованный секрет ресурса (строка подключения внешней базы и т.п.). */
  async getResourceSecret(id: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT secret FROM resources WHERE id = ?")
      .bind(id)
      .first<{ secret: string | null }>();
    return row?.secret ? decrypt(row.secret, this.env.ENCRYPTION_KEY) : null;
  }

  async deleteResource(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM wires WHERE source_id = ? OR target_id = ?").bind(id, id),
      this.db.prepare("DELETE FROM project_resources WHERE resource_id = ?").bind(id),
      this.db.prepare("DELETE FROM resources WHERE id = ?").bind(id),
    ]);
  }

  /** secret — строка подключения проекта к общей базе в изолированном режиме (хранится зашифрованной). */
  async bindResource(
    projectId: string,
    resourceId: string,
    role: string,
    meta: Record<string, string> = {},
    secret: string | null = null,
  ) {
    await this.db
      .prepare(
        `INSERT INTO project_resources (project_id, resource_id, role, meta, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, resource_id) DO UPDATE SET
           role = excluded.role, meta = excluded.meta, secret = excluded.secret`,
      )
      .bind(
        projectId,
        resourceId,
        role,
        JSON.stringify(meta),
        secret === null ? null : await encrypt(secret, this.env.ENCRYPTION_KEY),
        Date.now(),
      )
      .run();
  }

  async getBindingSecret(projectId: string, resourceId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT secret FROM project_resources WHERE project_id = ? AND resource_id = ?")
      .bind(projectId, resourceId)
      .first<{ secret: string | null }>();
    return row?.secret ? decrypt(row.secret, this.env.ENCRYPTION_KEY) : null;
  }

  async unbindResource(projectId: string, resourceId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM project_resources WHERE project_id = ? AND resource_id = ?")
      .bind(projectId, resourceId)
      .run();
  }

  /** Сколько проектов использует ресурс. */
  async bindingCount(resourceId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM project_resources WHERE resource_id = ?")
      .bind(resourceId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async setResourceSecret(id: string, secret: string): Promise<void> {
    await this.db
      .prepare("UPDATE resources SET secret = ? WHERE id = ?")
      .bind(await encrypt(secret, this.env.ENCRYPTION_KEY), id)
      .run();
  }

  async hasResourceSecret(id: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT secret IS NOT NULL AS has FROM resources WHERE id = ?")
      .bind(id)
      .first<{ has: number }>();
    return row?.has === 1;
  }

  // --- связи (выход ресурса → переменная другого ресурса) ---

  async listWires(projectId: string): Promise<Wire[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM wires WHERE project_id = ? ORDER BY created_at")
      .bind(projectId)
      .all<{
        source_id: string;
        output: string;
        target_id: string;
        name: string;
        applied_at: number | null;
        error: string | null;
      }>();
    return results.map((r) => ({
      sourceId: r.source_id,
      output: r.output,
      targetId: r.target_id,
      name: r.name,
      appliedAt: r.applied_at,
      error: r.error,
    }));
  }

  async saveWire(projectId: string, wire: Wire): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO wires (project_id, source_id, output, target_id, name, applied_at, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, target_id, name) DO UPDATE SET
           source_id = excluded.source_id, output = excluded.output,
           applied_at = excluded.applied_at, error = excluded.error`,
      )
      .bind(projectId, wire.sourceId, wire.output, wire.targetId, wire.name, wire.appliedAt, wire.error, Date.now())
      .run();
  }

  async deleteWire(projectId: string, targetId: string, name: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM wires WHERE project_id = ? AND target_id = ? AND name = ?")
      .bind(projectId, targetId, name)
      .run();
  }

  // --- events ---

  async addEvent(projectId: string, level: ProjectEvent["level"], message: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO events (project_id, level, message, created_at) VALUES (?, ?, ?, ?)")
      .bind(projectId, level, message, Date.now())
      .run();
  }

  async listEvents(projectId: string): Promise<ProjectEvent[]> {
    const { results } = await this.db
      .prepare("SELECT id, level, message, created_at FROM events WHERE project_id = ? ORDER BY id")
      .bind(projectId)
      .all<EventRow>();
    return results.map((r) => ({ id: r.id, level: r.level, message: r.message, createdAt: r.created_at }));
  }

  // --- алерты мониторинга ---

  async listAlerts(projectId?: string): Promise<(ProjectAlert & { projectId: string })[]> {
    const stmt = projectId
      ? this.db.prepare("SELECT * FROM alerts WHERE project_id = ? ORDER BY created_at").bind(projectId)
      : this.db.prepare("SELECT * FROM alerts ORDER BY created_at");
    const { results } = await stmt.all<{
      project_id: string;
      key: string;
      message: string;
      url: string | null;
      created_at: number;
    }>();
    return results.map((r) => ({
      projectId: r.project_id,
      key: r.key,
      message: r.message,
      url: r.url,
      createdAt: r.created_at,
    }));
  }

  /** true, если алерт новый — только тогда о нём уведомляем (защита от параллельных проверок). */
  async openAlert(projectId: string, alert: Omit<ProjectAlert, "createdAt">): Promise<boolean> {
    const res = await this.db
      .prepare("INSERT OR IGNORE INTO alerts (project_id, key, message, url, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(projectId, alert.key, alert.message, alert.url, Date.now())
      .run();
    return res.meta.changes === 1;
  }

  /** true, если алерт действительно был активен. */
  async resolveAlert(projectId: string, key: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM alerts WHERE project_id = ? AND key = ?").bind(projectId, key).run();
    return res.meta.changes === 1;
  }

  // --- служебные значения ---

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }
}
