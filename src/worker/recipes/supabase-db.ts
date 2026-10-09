// Общий шаг рецептов: проект Supabase с готовой базой и строкой подключения через пулер.
import { supabaseConsole } from "../providers/supabase";
import type { ProvisionContext } from "./types";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Пароль только из букв и цифр, чтобы без сюрпризов жить в строке подключения. */
function generatePassword(length = 32): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export interface SupabaseDatabase {
  ref: string;
  apiUrl: string;
  /** Session-mode пулер: работает по IPv4 (GitHub Actions, Render), поддерживает миграции. */
  dbUrl: string;
}

/** Создаёт проект Supabase, ждёт готовности базы и регистрирует его ресурсом проекта. */
export async function createSupabaseDatabase(ctx: ProvisionContext, regionGroup: string): Promise<SupabaseDatabase> {
  const sb = ctx.supabase();
  const { name } = ctx.project;

  await ctx.log("Создаю проект Supabase…");
  const dbPassword = generatePassword();
  const created = await sb.client.createProject({
    name,
    organizationSlug: sb.organizationSlug,
    dbPass: dbPassword,
    regionGroup,
  });
  const apiUrl = `https://${created.ref}.supabase.co`;
  const resource = await ctx.addResource({
    type: "supabase.project",
    kind: "database",
    name: `${name} (Supabase)`,
    externalId: created.ref,
    url: null,
    consoleUrl: supabaseConsole.project(created.ref),
    meta: { apiUrl },
  });

  await ctx.log("Жду, пока Supabase поднимет базу (обычно 1–3 минуты)…");
  const deadline = Date.now() + 6 * 60_000;
  for (;;) {
    const { status } = await sb.client.getProject(created.ref);
    if (status === "ACTIVE_HEALTHY") break;
    if (status === "INIT_FAILED") throw new Error("Supabase не смог создать проект (INIT_FAILED)");
    if (Date.now() > deadline) throw new Error(`Supabase слишком долго поднимает базу (статус ${status})`);
    await sleep(5000);
  }

  const dbUrl = await sb.client.sessionPoolerUrl(created.ref, dbPassword);
  // Пароль базы больше нигде не узнать — сохраняем строку подключения, чтобы передавать её другим ресурсам
  await ctx.setResourceSecret(resource.id, dbUrl);
  return { ref: created.ref, apiUrl, dbUrl };
}
