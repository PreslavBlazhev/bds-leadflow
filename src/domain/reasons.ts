import type { ScoreFacts, ScoreResult } from "./scoring";

/**
 * Кратки, разбираеми причини „защо е избран“ — само от правила, които реално са дали точки.
 * Техническите наблюдения (HTTPS, viewport таг и т.н.) остават в подробностите на контакта.
 */
export function humanReasons(score: ScoreResult, facts: Pick<ScoreFacts, "rating" | "reviewCount">): string[] {
  const out: string[] = [];
  const on = (rule: string) => score.lines.some((l) => l.rule === rule && l.applied && l.points > 0);
  if (on("noWebsite")) out.push("Няма открит сайт");
  if (on("websiteIssues")) out.push("Сайтът има видими пропуски");
  if (on("poorMobile")) out.push("Слаб вид на телефон (проверено)");
  if (on("goodReviews") && facts.rating !== null && facts.reviewCount !== null) out.push(`Добри отзиви: ${facts.rating.toFixed(1).replace(".", ",")} от ${facts.reviewCount}`);
  if (on("activeSocial")) out.push("Активна страница в социалните мрежи");
  if (out.length === 0 && on("verifiedPhone")) out.push("Проверен служебен телефон");
  return out;
}

export function humanReasonText(score: ScoreResult, facts: Pick<ScoreFacts, "rating" | "reviewCount">): string {
  const r = humanReasons(score, facts);
  return r.length ? r.join(" · ") : "Допустим контакт без силни сигнали";
}
