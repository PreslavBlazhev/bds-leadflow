import type { Settings } from "./settings";

/**
 * Обяснима, конфигурируема оценка (търговски приоритет, не оценка на платежоспособност).
 * Hard exclusions (контакт, DNC, издаден) НЕ са тук — те са в eligibility.ts.
 * Неизвестното остава неизвестно: липсващи/неразрешени данни не носят точки и имат обяснение.
 */
export const SCORE_RULE_VERSION = "2026-10-v1";

export interface ScoreFacts {
  city: string;
  websiteStatus: string; // UNCHECKED | FOUND | NOT_FOUND_AFTER_CHECK | UNREACHABLE
  websiteEvidence: boolean; // има записано доказателство за проверката
  auditIssues: string[]; // документирани проблеми от последната проверка
  poorMobile: boolean | null;
  strongModern: boolean | null;
  rating: number | null;
  reviewCount: number | null;
  ratingUsable: boolean; // източникът позволява производна употреба
  socialActive: boolean | null;
  phoneVerified: boolean;
  isChain: boolean | null;
}

export interface ScoreLine {
  rule: string;
  points: number;
  applied: boolean;
  why: string;
}

export interface ScoreResult {
  score: number;
  raw: number;
  ruleVersion: string;
  lines: ScoreLine[];
}

export function scoreBusiness(f: ScoreFacts, s: Settings): ScoreResult {
  const w = s.scoreWeights;
  const lines: ScoreLine[] = [];
  const add = (rule: string, points: number, applied: boolean, why: string) => lines.push({ rule, points: applied ? points : 0, applied, why });

  // Сайт: правилата "няма сайт" и "слаб сайт" са взаимно изключващи се.
  if (f.websiteStatus === "NOT_FOUND_AFTER_CHECK" && f.websiteEvidence) {
    add("noWebsite", w.noWebsite, true, "Сайт не е открит след описана проверка.");
  } else if (f.websiteStatus === "NOT_FOUND_AFTER_CHECK") {
    add("noWebsite", w.noWebsite, false, "Отбелязано „без сайт“, но липсва доказателство за проверката — без точки.");
  } else if (f.websiteStatus === "FOUND") {
    const weak = f.auditIssues.length > 0 || f.poorMobile === true;
    const strong = f.strongModern === true;
    if (weak && strong) {
      add("websiteIssues", w.websiteIssues, false, "Противоречиви проверки (силен и слаб сайт едновременно) — без точки, нужна е повторна проверка.");
    } else if (strong) {
      add("strongModernSite", w.strongModernSite, true, "Силен съвременен сайт според прозрачната проверка.");
    } else {
      if (f.auditIssues.length > 0) add("websiteIssues", w.websiteIssues, true, `Документирани проблеми: ${f.auditIssues.join("; ")}.`);
      else add("websiteIssues", w.websiteIssues, false, "Има сайт, но няма документирани проблеми.");
      if (f.poorMobile === true) add("poorMobile", w.poorMobile, true, "Потвърдено лошо мобилно представяне.");
      else add("poorMobile", w.poorMobile, false, f.poorMobile === null ? "Мобилното представяне не е проверено." : "Мобилното представяне е приемливо.");
    }
  } else if (f.websiteStatus === "UNREACHABLE") {
    add("noWebsite", w.noWebsite, false, "Сайтът е технически недостъпен — грешка/timeout не означава слаб сайт.");
  } else {
    add("noWebsite", w.noWebsite, false, "Сайтът не е проверен — липсващо поле не е доказателство за липса на сайт.");
  }

  if (!f.ratingUsable || f.rating === null || f.reviewCount === null) {
    add("goodReviews", w.goodReviews, false, f.ratingUsable ? "Няма данни за рейтинг/отзиви." : "Рейтингът е от източник без право за производна употреба.");
  } else {
    const ok = f.reviewCount > 20 && f.rating >= 4.2;
    add("goodReviews", w.goodReviews, ok, ok ? `Рейтинг ${f.rating.toFixed(1)} от ${f.reviewCount} отзива.` : `Рейтинг ${f.rating.toFixed(1)} / ${f.reviewCount} отзива — под прага (>20 и ≥4.2).`);
  }

  add("activeSocial", w.activeSocial, f.socialActive === true, f.socialActive === true ? "Потвърдена активна социална страница." : f.socialActive === null ? "Социалната активност е неизвестна." : "Няма активна социална страница.");
  add("verifiedPhone", w.verifiedPhone, f.phoneVerified, f.phoneVerified ? "Проверен публичен служебен телефон." : "Телефонът не е проверен.");

  const priority = s.priorityCities.some((c) => c.enabled && c.name === f.city);
  add("priorityCity", w.priorityCity, priority, priority ? `Приоритетен град (${f.city}).` : `${f.city} не е приоритетен град.`);

  add("bigChain", w.bigChain, f.isChain === true, f.isChain === true ? "Потвърдена голяма верига." : f.isChain === null ? "Неизвестно дали е верига." : "Не е верига.");

  const raw = lines.reduce((a, l) => a + l.points, 0);
  return { score: Math.max(0, Math.min(100, raw)), raw, ruleVersion: SCORE_RULE_VERSION, lines };
}

export const RULE_LABELS: Record<string, string> = {
  noWebsite: "Няма сайт (след проверка)",
  websiteIssues: "Сайт с проблеми",
  poorMobile: "Слабо мобилно представяне",
  goodReviews: "Добри отзиви",
  activeSocial: "Активна социална страница",
  verifiedPhone: "Проверен телефон",
  priorityCity: "Приоритетен град",
  strongModernSite: "Силен съвременен сайт",
  bigChain: "Голяма верига",
};
