// Привязка ресурсов к проектам, в том числе общей базы в двух режимах:
// isolated — своя схема и пользователь (по умолчанию), shared — полный доступ к данным базы.
import type { BoundResource, Resource } from "../shared/types";
import type { Store } from "./db";
import { createIsolation, dropIsolation } from "./isolation";
import { UserError, requireProject } from "./service";

export type BindMode = "isolated" | "shared";

/** Базы Postgres, которые можно делить между проектами. */
export const isSharableDatabase = (r: Resource) => r.type === "supabase.project" || r.type === "postgres.external";

/** Режим привязки базы; у баз, созданных для проекта рецептом или конструктором, режима нет — проект ими владеет. */
export const bindingMode = (r: BoundResource): BindMode | "owner" => (r.binding.mode as BindMode) ?? "owner";

async function adminUrl(store: Store, r: Resource): Promise<string> {
  const url = await store.getResourceSecret(r.id);
  if (!url) {
    throw new UserError(
      `Чтобы изолировать проект в «${r.name}», apphub нужна строка подключения базы — задайте её в каталоге ресурсов`,
    );
  }
  return url;
}

export async function bindToProject(
  store: Store,
  projectId: string,
  resourceId: string,
  mode: BindMode | undefined,
): Promise<string> {
  const project = await requireProject(store, projectId);
  const resource = await store.getResource(resourceId);
  if (!resource) throw new UserError("Ресурс не найден", 404);
  if ((await store.listResources(projectId)).some((r) => r.id === resourceId)) {
    throw new UserError("Ресурс уже привязан к проекту", 409);
  }

  if (!isSharableDatabase(resource)) {
    await store.bindResource(projectId, resource.id, resource.kind);
    await store.addEvent(projectId, "info", `Привязан ресурс: ${resource.name}`);
    return `Привязан ресурс: ${resource.name}`;
  }

  if ((mode ?? "isolated") === "shared") {
    await store.bindResource(projectId, resource.id, resource.kind, { mode: "shared" });
    const message = `Привязана база ${resource.name}: общие данные, полный доступ`;
    await store.addEvent(projectId, "info", message);
    return message;
  }

  const iso = await createIsolation(await adminUrl(store, resource), project.name, {
    supabaseRef: resource.type === "supabase.project" ? resource.externalId : undefined,
  });
  await store.bindResource(
    projectId,
    resource.id,
    resource.kind,
    { mode: "isolated", schema: iso.schema, role: iso.role },
    iso.url,
  );
  const message = `Привязана база ${resource.name}: изолированно, схема ${iso.schema}`;
  await store.addEvent(projectId, "info", message);
  return message;
}

/** Отвязывает ресурс; у изолированной базы удаляет схему проекта (с его данными) и его пользователя. */
export async function releaseBinding(store: Store, projectId: string, r: BoundResource): Promise<void> {
  if (bindingMode(r) === "isolated" && r.binding.schema && r.binding.role) {
    await dropIsolation(await adminUrl(store, r), r.binding.schema, r.binding.role);
    await store.addEvent(projectId, "info", `Удалены схема ${r.binding.schema} и пользователь проекта в ${r.name}`);
  }
  await store.unbindResource(projectId, r.id);
}
