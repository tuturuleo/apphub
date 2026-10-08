// Доступ к D1: строки таблиц ↔ общие типы.
import type {
  Connection,
  Project,
  ProjectEvent,
  ProjectStatus,
  ProviderId,
  Resource,
  ResourceKind,
  ResourceType,
} from "../shared/types";
import { decrypt, encrypt } from "./crypto";
import type { AppEnv } from "./env";

interface ConnectionRow {
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
  project_id: string;
  type: ResourceType;
  kind: ResourceKind;
  name: string;
  external_id: string;
  url: string | null;
  console_url: string | null;
  meta: string;
  created_at: number;
}

interface EventRow {
  id: number;
  level: "info" | "error";
  message: string;
  created_at: number;
}

const toConnection = (r: ConnectionRow): Connection => ({
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
  projectId: r.project_id,
  type: r.type,
  kind: r.kind,
  name: r.name,
  externalId: r.external_id,
  url: r.url,
  consoleUrl: r.console_url,
  meta: JSON.parse(r.meta),
  createdAt: r.created_at,
});

export class Store {
  constructor(private env: AppEnv) {}

  private get db() {
    return this.env.DB;
  }

  // --- connections ---

  async listConnections(): Promise<Connection[]> {
    const { results } = await this.db.prepare("SELECT * FROM connections ORDER BY created_at").all<ConnectionRow>();
    return results.map(toConnection);
  }

  async getConnection(provider: ProviderId): Promise<(Connection & { token: string }) | null> {
    const row = await this.db.prepare("SELECT * FROM connections WHERE provider = ?").bind(provider).first<ConnectionRow>();
    if (!row) return null;
    let token: string;
    try {
      token = await decrypt(row.secret, this.env.ENCRYPTION_KEY);
    } catch {
      // например, сменился ENCRYPTION_KEY
      throw new Error(`Не удалось расшифровать токен ${provider} — подключите его заново`);
    }
    return { ...toConnection(row), token };
  }

  async saveConnection(c: Omit<Connection, "createdAt">, token: string): Promise<void> {
    const secret = await encrypt(token, this.env.ENCRYPTION_KEY);
    await this.db
      .prepare(
        `INSERT INTO connections (provider, label, account_id, secret, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           label = excluded.label, account_id = excluded.account_id,
           secret = excluded.secret, meta = excluded.meta`,
      )
      .bind(c.provider, c.label, c.accountId, secret, JSON.stringify(c.meta), Date.now())
      .run();
  }

  async deleteConnection(provider: ProviderId): Promise<void> {
    await this.db.prepare("DELETE FROM connections WHERE provider = ?").bind(provider).run();
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

  async projectNameTaken(name: string): Promise<boolean> {
    return (await this.db.prepare("SELECT 1 FROM projects WHERE name = ?").bind(name).first()) !== null;
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

  async getResource(projectId: string, id: string): Promise<Resource | null> {
    const row = await this.db
      .prepare("SELECT * FROM resources WHERE project_id = ? AND id = ?")
      .bind(projectId, id)
      .first<ResourceRow>();
    return row ? toResource(row) : null;
  }

  async setProjectStatus(id: string, status: ProjectStatus, error: string | null = null): Promise<void> {
    await this.db.prepare("UPDATE projects SET status = ?, error = ? WHERE id = ?").bind(status, error, id).run();
  }

  async deleteProject(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM events WHERE project_id = ?").bind(id),
      this.db.prepare("DELETE FROM resources WHERE project_id = ?").bind(id),
      this.db.prepare("DELETE FROM projects WHERE id = ?").bind(id),
    ]);
  }

  // --- resources ---

  async listResources(projectId?: string): Promise<Resource[]> {
    const stmt = projectId
      ? this.db.prepare("SELECT * FROM resources WHERE project_id = ? ORDER BY created_at").bind(projectId)
      : this.db.prepare("SELECT * FROM resources ORDER BY created_at");
    const { results } = await stmt.all<ResourceRow>();
    return results.map(toResource);
  }

  async addResource(r: Omit<Resource, "id" | "createdAt">): Promise<Resource> {
    const resource: Resource = { ...r, id: crypto.randomUUID(), createdAt: Date.now() };
    await this.db
      .prepare(
        `INSERT INTO resources (id, project_id, type, kind, name, external_id, url, console_url, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        resource.id,
        resource.projectId,
        resource.type,
        resource.kind,
        resource.name,
        resource.externalId,
        resource.url,
        resource.consoleUrl,
        JSON.stringify(resource.meta),
        resource.createdAt,
      )
      .run();
    return resource;
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
}
