// Создаёт .dev.vars с ключом шифрования для локальной разработки (если файла ещё нет).
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const path = new URL("../.dev.vars", import.meta.url);
if (existsSync(path)) {
  console.log(".dev.vars уже существует — пропускаю");
} else {
  const key = randomBytes(32).toString("base64");
  writeFileSync(path, `ENCRYPTION_KEY=${key}\nDEV_ALLOW_NO_AUTH=true\n`);
  console.log("Создан .dev.vars");
}
