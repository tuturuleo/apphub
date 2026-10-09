// Бесплатные LLM: Workers AI прямо из Worker AppHub (привязка AI, без ключей) и провайдеры с OpenAI-совместимым API
// по ключу — Groq, OpenRouter, Mistral, NVIDIA или любой свой адрес. Модели — ресурсы каталога: их можно отдать
// ассистенту AppHub и передать в проекты переменными LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
import type { Connection, ProviderId } from "../shared/types";
import type { AppEnv } from "./env";
import { ProviderError } from "./providers/errors";
import { relayFetch } from "./providers/http";

export type LlmProviderId = "groq" | "openrouter" | "mistral" | "nvidia" | "openai_compat";

export const LLM_PROVIDER_IDS: LlmProviderId[] = ["groq", "openrouter", "mistral", "nvidia", "openai_compat"];

export const isLlmProvider = (p: ProviderId | string): p is LlmProviderId => (LLM_PROVIDER_IDS as string[]).includes(p);

interface Preset {
  name: string;
  baseUrl: string;
  /** Модели, которые стоит предложить первыми: бесплатные и умеющие вызывать функции. */
  suggested: string[];
  /** Какие модели из списка провайдера показывать (например, только бесплатные у OpenRouter). */
  keep?(model: RawModel): boolean;
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  capabilities?: { function_calling?: boolean; completion_chat?: boolean };
  pricing?: { prompt?: string; completion?: string };
  active?: boolean;
}

export const LLM_PRESETS: Record<Exclude<LlmProviderId, "openai_compat">, Preset> = {
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    suggested: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
    keep: (m) => m.active !== false && !/whisper|tts|guard|orpheus/i.test(m.id),
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    suggested: ["openrouter/free", "nvidia/nemotron-3-super-120b-a12b:free", "google/gemma-4-31b-it:free"],
    // Только бесплатные варианты; у остальных нужна оплата
    keep: (m) =>
      m.id.endsWith(":free") ||
      m.id === "openrouter/free" ||
      (m.pricing?.prompt === "0" && m.pricing?.completion === "0"),
  },
  mistral: {
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    suggested: ["mistral-small-latest", "mistral-medium-latest"],
    keep: (m) => m.capabilities?.completion_chat !== false,
  },
  nvidia: {
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    suggested: ["openai/gpt-oss-120b", "nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-20b"],
    keep: (m) => !/embed|rerank|vision|parse|guard|safety|reward|clip|retriever/i.test(m.id),
  },
};

/** Модели Workers AI, доступные ассистенту без ключей. Дешёвые первыми: дневной бесплатный лимит общий. */
export const WORKERS_AI_MODELS: { id: string; label: string; extra?: Record<string, unknown> }[] = [
  // Рассуждающие модели на длинной инструкции ассистента не укладываются во время — рассуждения выключаем
  {
    id: "@cf/zai-org/glm-4.7-flash",
    label: "GLM-4.7 Flash — экономная, по умолчанию",
    extra: { chat_template_kwargs: { enable_thinking: false } },
  },
  { id: "@cf/openai/gpt-oss-120b", label: "gpt-oss-120b — сильнее, расходует лимит быстрее" },
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
];
export const DEFAULT_WORKERS_AI_MODEL = WORKERS_AI_MODELS[0].id;

/** Адрес и ключ из подключения. У «любого OpenAI-совместимого» токен хранится как «адрес\nключ». */
export function llmCredentials(c: Pick<Connection, "provider"> & { token: string }): { baseUrl: string; key: string } {
  if (c.provider === "openai_compat") {
    const [url, ...rest] = c.token.split("\n").map((s) => s.trim());
    return { baseUrl: url.replace(/\/+$/, ""), key: rest.join("").trim() };
  }
  return { baseUrl: LLM_PRESETS[c.provider as keyof typeof LLM_PRESETS].baseUrl, key: c.token.trim() };
}

export function providerName(provider: LlmProviderId, baseUrl?: string): string {
  if (provider !== "openai_compat") return LLM_PRESETS[provider].name;
  try {
    return new URL(baseUrl ?? "").hostname;
  } catch {
    return "OpenAI-совместимый";
  }
}

async function request<T>(name: string, url: string, key: string, init: RequestInit = {}): Promise<T> {
  const res = await relayFetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      message = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? message;
    } catch {
      // не JSON
    }
    throw new ProviderError(`${name}: ${res.status} ${message}`, res.status);
  }
  return (await res.json()) as T;
}

export interface LlmModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** Известно, что модель умеет вызывать функции (нужно ассистенту). null — провайдер не сообщает. */
  tools: boolean | null;
  suggested: boolean;
}

/** Модели аккаунта: подходящие для чата, рекомендованные первыми. */
export async function listModels(provider: LlmProviderId, baseUrl: string, key: string): Promise<LlmModelInfo[]> {
  const name = providerName(provider, baseUrl);
  const res = await request<{ data: RawModel[] }>(name, `${baseUrl}/models`, key);
  const preset = provider === "openai_compat" ? null : LLM_PRESETS[provider];
  const models = (res.data ?? []).filter((m) => (preset?.keep ? preset.keep(m) : true));
  const suggested = preset?.suggested ?? [];
  return models
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? null,
      tools: m.supported_parameters
        ? m.supported_parameters.includes("tools")
        : (m.capabilities?.function_calling ?? null),
      suggested: suggested.includes(m.id),
    }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.id.localeCompare(b.id));
}

/** Проверка ключа при подключении. Возвращает подпись аккаунта. */
export async function verifyLlmKey(
  provider: LlmProviderId,
  token: string,
): Promise<Omit<Connection, "id" | "createdAt">> {
  const { baseUrl, key } = llmCredentials({ provider, token });
  if (provider === "openai_compat") {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("Первая строка — адрес API по https, например https://api.example.com/v1; вторая — ключ");
    }
  }
  if (!key) throw new Error("Вставьте ключ API");
  const name = providerName(provider, baseUrl);

  if (provider === "openrouter") {
    // Список моделей OpenRouter отдаёт и без ключа — проверяем сам ключ
    const info = await request<{ data: { label?: string; is_free_tier?: boolean } }>(name, `${baseUrl}/key`, key);
    return {
      provider,
      label: info.data.label || "ключ OpenRouter",
      accountId: await fingerprint(key),
      meta: { baseUrl },
    };
  }
  if (provider === "nvidia") {
    // Список моделей NVIDIA открыт всем — ключ подтверждаем коротким запросом
    await request(name, `${baseUrl}/chat/completions`, key, {
      method: "POST",
      body: JSON.stringify({
        model: LLM_PRESETS.nvidia.suggested[0],
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
      }),
    });
    return { provider, label: "ключ NVIDIA", accountId: await fingerprint(key), meta: { baseUrl } };
  }
  const models = await listModels(provider, baseUrl, key);
  return {
    provider,
    label: `${name}: моделей ${models.length}`,
    accountId: await fingerprint(`${baseUrl}|${key}`),
    meta: { baseUrl },
  };
}

/** Отпечаток ключа вместо самого ключа — чтобы различать аккаунты, не храня ключ открыто. */
async function fingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- вызов модели (формат OpenAI Chat Completions) ---

export interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OaiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OaiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OaiResponse {
  choices: {
    message: { content: string | null; tool_calls?: OaiToolCall[]; reasoning_content?: string };
    finish_reason: string;
  }[];
}

/** Куда отправлять запрос: привязка Workers AI или HTTP-провайдер с ключом. */
export type LlmTarget =
  | { kind: "workers-ai"; model: string; extra?: Record<string, unknown> }
  | { kind: "http"; provider: LlmProviderId; baseUrl: string; key: string; model: string };

export async function chatCompletion(
  env: AppEnv,
  target: LlmTarget,
  body: { messages: OaiMessage[]; tools?: OaiTool[]; max_tokens?: number },
  fetchImpl: typeof fetch = relayFetch,
): Promise<OaiResponse> {
  if (target.kind === "workers-ai") {
    if (!env.AI) throw new ProviderError("Workers AI недоступен: у Worker нет привязки AI", 500);
    // Workers AI время от времени отвечает «internal error» на тот же запрос, который через секунду проходит
    for (let attempt = 1; ; attempt++) {
      try {
        return (await env.AI.run(
          target.model as never,
          {
            ...target.extra,
            ...body,
            max_tokens: body.max_tokens ?? 4096,
          } as never,
        )) as unknown as OaiResponse;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/neuron|quota|4006/i.test(message)) {
          throw new ProviderError("Дневной бесплатный лимит Workers AI исчерпан — он обновится в 03:00 по Москве", 429);
        }
        if (/internal error|InferenceUpstreamError/i.test(message) && attempt < 3) continue;
        throw new ProviderError(`Workers AI: ${message.split("\n")[0]}`, 502);
      }
    }
  }
  const name = providerName(target.provider, target.baseUrl);
  const res = await fetchImpl(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${target.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: target.model, ...body, max_tokens: body.max_tokens ?? 4096 }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 300);
    try {
      const err = JSON.parse(text) as { error?: { message?: string } | string };
      message = (typeof err.error === "string" ? err.error : err.error?.message) ?? message;
    } catch {
      // не JSON
    }
    if (res.status === 429) throw new ProviderError(`${name}: лимит бесплатного тарифа — ${message}`, 429);
    throw new ProviderError(`${name}: ${res.status} ${message}`, res.status);
  }
  return (await res.json()) as OaiResponse;
}
