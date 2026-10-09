// Общий шаг: сервис Render из GitHub-репозитория. Render узнаёт о новом репозитории не мгновенно.
import { ProviderError } from "../providers/errors";
import { sleep } from "./supabase-db";
import type { ProvisionContext } from "./types";

const REPO_VISIBLE_ATTEMPTS = 8;
const REPO_VISIBLE_DELAY_MS = 12_000;

/**
 * Render узнаёт о новом репозитории через своё GitHub-приложение не мгновенно — повторяем, пока не увидит.
 * Если так и не увидел, почти наверняка приложению Render не дан доступ ко всем репозиториям.
 */
export async function createServiceWhenRepoVisible<T>(ctx: ProvisionContext, create: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await create();
    } catch (e) {
      const unfetchable = e instanceof ProviderError && e.status === 400 && /unfetchable/i.test(e.message);
      if (!unfetchable) throw e;
      if (attempt >= REPO_VISIBLE_ATTEMPTS) {
        throw new Error(
          "Render не видит репозиторий. В Render: Account Settings → Account Security → Git Deployment Credentials " +
            "→ Add credential → GitHub (вход через GitHub для деплоя не годится); в GitHub у приложения Render — " +
            "All repositories. Затем удалите этот проект и создайте заново.",
        );
      }
      if (attempt === 1) await ctx.log("Render ещё не видит новый репозиторий — жду…");
      await sleep(REPO_VISIBLE_DELAY_MS);
    }
  }
}

