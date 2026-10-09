// Вход в apphub: passkey владельца. Первый passkey — с кодом установки (секрет SETUP_CODE).
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { ErrorNote, Loading } from "./components";
import { errorMessage } from "./queries";

export const authKey = ["auth"] as const;

export const useAuthState = () => useQuery({ queryKey: authKey, queryFn: api.authState, staleTime: 60_000 });

/** Имя устройства по умолчанию — чтобы в списке passkeys было понятно, где какой. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}

/** Отмена системного окна passkey — не ошибка, о которой стоит кричать. */
function friendly(e: unknown): string | null {
  if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) {
    return "Окно passkey закрыто или время вышло — попробуйте ещё раз";
  }
  return errorMessage(e);
}

export async function registerPasskey(setupCode?: string, name = deviceName()): Promise<void> {
  const { challengeId, options } = await api.registerOptions(setupCode);
  const response = await startRegistration({ optionsJSON: options });
  await api.registerVerify(challengeId, response, name);
}

async function login(): Promise<void> {
  const { challengeId, options } = await api.loginOptions();
  const response = await startAuthentication({ optionsJSON: options });
  await api.loginVerify(challengeId, response);
}

/** Пускает в интерфейс только после входа. Истёкшая сессия возвращает на экран входа. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const state = useAuthState();

  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: authKey });
    window.addEventListener("apphub:unauthorized", onUnauthorized);
    return () => window.removeEventListener("apphub:unauthorized", onUnauthorized);
  }, [qc]);

  if (state.isPending) return <Loading />;
  if (state.error) return <ErrorNote message={errorMessage(state.error)} />;
  if (state.data.authenticated) return <>{children}</>;
  return <LoginScreen configured={state.data.configured} setupCodeSet={state.data.setupCodeSet} />;
}

function LoginScreen({ configured, setupCodeSet }: { configured: boolean; setupCodeSet: boolean }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "setup">(configured ? "login" : "setup");
  const [code, setCode] = useState("");
  const done = async () => {
    // Данные, запрошенные до входа, получили 401 — перезапрашиваем всё
    await qc.invalidateQueries();
  };
  const signIn = useMutation({ mutationFn: login, onSuccess: done });
  const setup = useMutation({ mutationFn: () => registerPasskey(code), onSuccess: done });

  if (!browserSupportsWebAuthn()) {
    return (
      <div className="auth-screen">
        <h1>AppHub</h1>
        <p className="note note-error">
          Этот браузер не поддерживает passkeys. Откройте AppHub в свежем Chrome, Safari или Firefox.
        </p>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <h1>
        <span className="brand-mark" aria-hidden>
          ▲
        </span>{" "}
        AppHub
      </h1>
      {mode === "login" ? (
        <>
          <p className="muted">Вход по passkey — Touch ID, Face ID, Windows Hello или ключ безопасности.</p>
          <ErrorNote message={friendly(signIn.error)} />
          <button className="button" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
            {signIn.isPending ? "Жду подтверждения…" : "Войти"}
          </button>
          <button className="button button-quiet" onClick={() => setMode("setup")}>
            Новое устройство или нет доступа
          </button>
        </>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            setup.mutate();
          }}
        >
          <p className="muted">
            {configured
              ? "Добавьте passkey на этом устройстве. Нужен код установки — тот, что задан секретом SETUP_CODE при развёртывании."
              : "Первый вход: создайте passkey владельца. Нужен код установки — секрет SETUP_CODE, заданный при развёртывании."}
          </p>
          {!setupCodeSet && (
            <p className="note note-error">
              Код установки не задан. Задайте его: <code>npx wrangler secret put SETUP_CODE</code>
            </p>
          )}
          <label className="field">
            <span>Код установки</span>
            <input
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <ErrorNote message={friendly(setup.error)} />
          <div className="row">
            <button className="button" type="submit" disabled={setup.isPending || !setupCodeSet}>
              {setup.isPending ? "Жду подтверждения…" : "Создать passkey"}
            </button>
            {configured && (
              <button className="button button-quiet" type="button" onClick={() => setMode("login")}>
                Назад ко входу
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
