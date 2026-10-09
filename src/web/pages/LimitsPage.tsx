import type { LimitItem } from "../../shared/types";
import { ErrorNote, ExternalLink, Loading, StatusDot } from "../components";
import { formatAmount } from "../limits";
import { errorMessage, useLimits } from "../queries";
import { href } from "../router";

const STATE_LABEL: Record<LimitItem["state"], string> = {
  ok: "Есть запас",
  warn: "Почти исчерпан",
  full: "Исчерпан",
  info: "Только лимит",
};

const DOT: Record<LimitItem["state"], "ok" | "warn" | "error" | "unknown"> = {
  ok: "ok",
  warn: "warn",
  full: "error",
  info: "unknown",
};

export function LimitsPage() {
  const limits = useLimits();

  return (
    <>
      <div className="page-head">
        <h1>Лимиты</h1>
        <button className="button button-quiet" onClick={() => void limits.refetch()} disabled={limits.isFetching}>
          {limits.isFetching ? "Обновляю…" : "Обновить"}
        </button>
      </div>
      <p className="muted lead">
        Ограничения бесплатных тарифов подключённых провайдеров. Что видно через API — посчитано; остальное показано
        как известный лимит со ссылкой на страницу потребления. Приближение к лимиту приходит в Telegram, а рецепт с
        исчерпанным лимитом apphub не даст создать.
      </p>

      <ErrorNote message={errorMessage(limits.error)} />
      {limits.isPending && <Loading />}
      {limits.data?.length === 0 && (
        <p className="muted">
          Нет подключённых провайдеров. <a href={href.connections}>Подключить</a>
        </p>
      )}

      <ul className="resource-list">
        {limits.data?.map((l) => (
          <li key={l.key} className="resource limit">
            <StatusDot state={DOT[l.state]} />
            <div className="resource-main">
              <div className="resource-title">
                <strong>{l.label}</strong>
                <span className={`kind limit-${l.state}`}>{STATE_LABEL[l.state]}</span>
              </div>
              <div className="limit-amount">
                {l.used !== null ? (
                  <>
                    {formatAmount(l.used, l.unit)} <span className="muted">из {formatAmount(l.limit, l.unit)}</span>
                  </>
                ) : (
                  <span className="muted">лимит {formatAmount(l.limit, l.unit)}</span>
                )}
              </div>
              {l.used !== null && (
                <div className="limit-bar" aria-hidden>
                  <div
                    className={`limit-fill limit-fill-${l.state}`}
                    style={{ width: `${Math.min(100, (l.used / l.limit) * 100)}%` }}
                  />
                </div>
              )}
              {l.holders.length > 0 && <div className="muted small">Занято: {l.holders.join(", ")}</div>}
              {l.note && <div className="muted small">{l.note}</div>}
            </div>
            {l.consoleUrl && (
              <div className="links">
                <ExternalLink url={l.consoleUrl}>Консоль</ExternalLink>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
