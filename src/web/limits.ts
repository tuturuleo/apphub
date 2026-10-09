import type { LimitItem } from "../shared/types";

const GB = 1024 ** 3;

export function formatAmount(value: number, unit: LimitItem["unit"]): string {
  switch (unit) {
    case "bytes":
      if (value >= GB) return `${(value / GB).toFixed(1)} ГБ`;
      if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} МБ`;
      return `${Math.max(1, Math.round(value / 1024))} КБ`;
    case "hours":
      return `${value} ч`;
    case "minutes":
      return `${value} мин`;
    case "requests":
      return value.toLocaleString("ru-RU");
    case "neurons":
      return `${value.toLocaleString("ru-RU")} нейронов`;
    default:
      return String(value);
  }
}
