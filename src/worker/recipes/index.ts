import type { RecipeInfo } from "../../shared/types";
import { cfFullstack } from "./cf-fullstack";
import { sheetSite } from "./sheet-site";
import type { Recipe } from "./types";

export const RECIPES: Recipe[] = [cfFullstack, sheetSite];

export function findRecipe(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function recipeInfo(r: Recipe): RecipeInfo {
  const { id, name, summary, stack, requires, fields, notes } = r;
  return { id, name, summary, stack, requires, fields, notes };
}
