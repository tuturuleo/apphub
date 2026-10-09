import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels, llmCredentials, verifyLlmKey } from "../src/worker/llm";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => unknown, status = 200) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(handler(url, init)), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

describe("LLM-провайдеры", () => {
  it("свой OpenAI-совместимый: адрес на первой строке, ключ на второй", () => {
    expect(llmCredentials({ provider: "openai_compat", token: "https://llm.example.com/v1/\n  sk-abc  \n" })).toEqual({
      baseUrl: "https://llm.example.com/v1",
      key: "sk-abc",
    });
    expect(llmCredentials({ provider: "groq", token: " gsk_1 " })).toEqual({
      baseUrl: "https://api.groq.com/openai/v1",
      key: "gsk_1",
    });
  });

  it("OpenRouter: только бесплатные модели, рекомендованные первыми, с признаком инструментов", async () => {
    stubFetch(() => ({
      data: [
        { id: "anthropic/claude-x", pricing: { prompt: "0.001", completion: "0.002" } },
        { id: "a/zeta:free", supported_parameters: ["tools"] },
        { id: "google/gemma-4-31b-it:free", supported_parameters: ["temperature"] },
      ],
    }));
    const models = await listModels("openrouter", "https://openrouter.ai/api/v1", "k");
    expect(models.map((m) => m.id)).toEqual(["google/gemma-4-31b-it:free", "a/zeta:free"]);
    expect(models.map((m) => m.tools)).toEqual([false, true]);
  });

  it("ключ проверяется у провайдера и не попадает в данные подключения", async () => {
    const calls = stubFetch(() => ({ data: [{ id: "openai/gpt-oss-120b" }] }));
    const c = await verifyLlmKey("groq", "gsk_secret");
    expect(calls[0]).toEqual({ url: "https://api.groq.com/openai/v1/models", auth: "Bearer gsk_secret" });
    expect(JSON.stringify(c)).not.toContain("gsk_secret");
    expect(c.label).toBe("Groq: моделей 1");
  });

  it("неверный ключ — понятная ошибка", async () => {
    stubFetch(() => ({ error: { message: "Invalid API Key" } }), 401);
    await expect(verifyLlmKey("groq", "bad")).rejects.toThrow(/Groq: 401 Invalid API Key/);
  });

  it("свой адрес только по https", async () => {
    await expect(verifyLlmKey("openai_compat", "http://insecure.example/v1\nk")).rejects.toThrow(/https/);
  });
});
