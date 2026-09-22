export type SearchFreshness = "pd" | "pw" | "pm" | "py";

export function inferSearchFreshness(query: string): SearchFreshness | undefined {
  const normalized = query.toLocaleLowerCase();
  if (/(?:сегодня|\btoday\b|за сутки|последние 24 часа)/u.test(normalized)) return "pd";
  if (/(?:на этой неделе|за неделю|последн(?:юю|ие) недел|\bthis week\b|\bpast week\b|\blast week\b)/u.test(normalized)) return "pw";
  if (/(?:новост|свеж|последн|недел|месяц|\blatest\b|\brecent\b|\bnews\b|\bpast month\b|\blast month\b)/u.test(normalized)) return "pm";
  if (/(?:в этом году|за год|\bthis year\b|\bpast year\b|\blast year\b)/u.test(normalized)) return "py";
  return undefined;
}

export function resolveSearchCountry(language: string, timezone: string): string | undefined {
  if (timezone === "Asia/Almaty" || timezone === "Asia/Qostanay") return "KZ";
  const region = language.match(/[-_]([A-Za-z]{2})\b/)?.[1];
  return region?.toUpperCase();
}

export function searchErrorCode(error: unknown): string {
  const message = String(error);
  return message.match(/SEARCH_[A-Z_]+/)?.[0] ?? "SEARCH_UNKNOWN";
}
