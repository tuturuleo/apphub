// Клиент GitHub REST API: репозитории, коммиты через Git Data API, секреты Actions, Pages, запуски workflow.
import type { WorkflowRun } from "../../shared/types";
import { fromBase64, toBase64 } from "../crypto";
import { sealedBox } from "../sealed-box";
import { ProviderError } from "./errors";
import { providerFetch } from "./http";

export interface RepoFile {
  path: string;
  content: string;
}

interface Repo {
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

export class GitHub {
  constructor(private token: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await providerFetch("GitHub", `https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "apphub",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const json = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        message = [json.message, ...(json.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
      } catch {
        // оставляем текст как есть
      }
      throw new ProviderError(`GitHub ${method} ${path}: ${res.status} ${message}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async viewer(): Promise<{ login: string; name: string | null; html_url: string }> {
    return this.request("GET", "/user");
  }

  async createRepo(opts: { name: string; description: string; private: boolean }): Promise<Repo> {
    // auto_init нужен, чтобы в репо сразу был коммит и работал Git Data API
    return this.request("POST", "/user/repos", { ...opts, auto_init: true });
  }

  async getRepo(fullName: string): Promise<Repo> {
    return this.request("GET", `/repos/${fullName}`);
  }

  private async headSha(fullName: string, branch: string): Promise<string> {
    // Сразу после создания репо ветка может появиться с задержкой
    for (let attempt = 0; ; attempt++) {
      try {
        const ref = await this.request<{ object: { sha: string } }>(
          "GET",
          `/repos/${fullName}/git/ref/heads/${branch}`,
        );
        return ref.object.sha;
      } catch (e) {
        const retriable = e instanceof ProviderError && (e.status === 404 || e.status === 409);
        if (!retriable || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  /** Один коммит, полностью заменяющий содержимое ветки переданными файлами. */
  async commitFiles(fullName: string, branch: string, files: RepoFile[], message: string): Promise<string> {
    const parent = await this.headSha(fullName, branch);
    const tree = await this.request<{ sha: string }>("POST", `/repos/${fullName}/git/trees`, {
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    });
    const commit = await this.request<{ sha: string }>("POST", `/repos/${fullName}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [parent],
    });
    await this.request("PATCH", `/repos/${fullName}/git/refs/heads/${branch}`, { sha: commit.sha });
    return commit.sha;
  }

  async setActionsSecret(fullName: string, name: string, value: string): Promise<void> {
    const pk = await this.request<{ key_id: string; key: string }>(
      "GET",
      `/repos/${fullName}/actions/secrets/public-key`,
    );
    const sealed = await sealedBox(new TextEncoder().encode(value), fromBase64(pk.key));
    await this.request("PUT", `/repos/${fullName}/actions/secrets/${name}`, {
      encrypted_value: toBase64(sealed),
      key_id: pk.key_id,
    });
  }

  /** Включает GitHub Pages с публикацией из Actions. */
  async enablePages(fullName: string): Promise<{ html_url: string }> {
    try {
      return await this.request("POST", `/repos/${fullName}/pages`, { build_type: "workflow" });
    } catch (e) {
      if (e instanceof ProviderError && e.status === 409) return this.getPages(fullName);
      throw e;
    }
  }

  async getPages(fullName: string): Promise<{ html_url: string; status: string | null }> {
    return this.request("GET", `/repos/${fullName}/pages`);
  }

  async listRuns(fullName: string, limit = 5): Promise<WorkflowRun[]> {
    const data = await this.request<{
      workflow_runs: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        event: string;
        html_url: string;
        created_at: string;
        head_commit: { message: string } | null;
      }[];
    }>("GET", `/repos/${fullName}/actions/runs?per_page=${limit}`);
    return data.workflow_runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      event: r.event,
      url: r.html_url,
      commitMessage: r.head_commit?.message.split("\n")[0] ?? null,
      createdAt: r.created_at,
    }));
  }

  async dispatchWorkflow(fullName: string, workflowFile: string, ref: string): Promise<void> {
    await this.request("POST", `/repos/${fullName}/actions/workflows/${workflowFile}/dispatches`, { ref });
  }
}
