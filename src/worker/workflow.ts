// Фоновое создание ресурсов проекта. Workflow живёт независимо от HTTP-запроса,
// поэтому создание доходит до конца, даже если клиент (вкладка, MCP) перестал ждать ответа.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Store } from "./db";
import { provision } from "./engine";
import type { AppEnv } from "./env";
import { findRecipe } from "./recipes";

export class ProvisionWorkflow extends WorkflowEntrypoint<AppEnv, { projectId: string }> {
  async run(event: Readonly<WorkflowEvent<{ projectId: string }>>, step: WorkflowStep) {
    // Один шаг без повторов: рецепты создают реальные ресурсы и не идемпотентны —
    // повтор создал бы дубликаты. Ошибки provision() сам записывает в проект.
    await step.do("provision", { retries: { limit: 0, delay: 0 }, timeout: "20 minutes" }, async () => {
      const store = new Store(this.env);
      const project = await store.getProject(event.payload.projectId);
      if (!project || project.status !== "provisioning") return;
      const recipe = findRecipe(project.recipeId);
      if (!recipe) {
        await store.setProjectStatus(project.id, "failed", "Рецепт больше не существует");
        return;
      }
      await provision(store, recipe, project);
    });
  }
}
