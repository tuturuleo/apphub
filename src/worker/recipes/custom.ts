import type { Recipe } from "./types";

/** Пустой проект: ресурсы добавляются потом — новые или из каталога — и связываются переменными. */
export const customProject: Recipe = {
  id: "custom",
  name: "Собрать самому",
  summary:
    "Пустой проект: добавьте ресурсы — новые (репозиторий, база, сервис Render, Telegram-бот) или из каталога — и свяжите их переменными.",
  stack: ["Любые ресурсы"],
  requires: [],
  needs: [],
  russia: { ok: true, note: null },
  fields: [],
  notes: ["Ресурсы добавляются на странице проекта после создания."],

  async provision(ctx) {
    await ctx.log("Пустой проект создан — добавьте ресурсы на странице проекта");
  },
};
