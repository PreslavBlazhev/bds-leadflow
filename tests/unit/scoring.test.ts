import { describe, expect, it } from "vitest";
import { scoreBusiness, type ScoreFacts } from "@/domain/scoring";
import { DEFAULT_SETTINGS } from "@/domain/settings";

const base: ScoreFacts = {
  city: "Варна",
  websiteStatus: "UNCHECKED",
  websiteEvidence: false,
  auditIssues: [],
  poorMobile: null,
  strongModern: null,
  rating: null,
  reviewCount: null,
  ratingUsable: false,
  socialActive: null,
  phoneVerified: false,
  isChain: null,
};
const s = DEFAULT_SETTINGS;
const applied = (r: ReturnType<typeof scoreBusiness>) => r.lines.filter((l) => l.applied).map((l) => l.rule);

describe("T24 score", () => {
  it("ограничен в [0,100] с breakdown", () => {
    const max = scoreBusiness({ ...base, websiteStatus: "NOT_FOUND_AFTER_CHECK", websiteEvidence: true, rating: 4.8, reviewCount: 200, ratingUsable: true, socialActive: true, phoneVerified: true }, { ...s, scoreWeights: { ...s.scoreWeights, noWebsite: 90 } });
    expect(max.score).toBe(100);
    expect(max.raw).toBeGreaterThan(100);
    const min = scoreBusiness({ ...base, city: "Русе", isChain: true }, s);
    expect(min.score).toBe(0);
    expect(min.raw).toBeLessThan(0);
    expect(min.lines.length).toBeGreaterThan(5);
  });
  it("„няма сайт“ и „сайт с проблеми“ са взаимно изключващи се", () => {
    const r = scoreBusiness({ ...base, websiteStatus: "NOT_FOUND_AFTER_CHECK", websiteEvidence: true, auditIssues: ["x"], poorMobile: true }, s);
    expect(applied(r)).toContain("noWebsite");
    expect(applied(r)).not.toContain("websiteIssues");
    expect(applied(r)).not.toContain("poorMobile"); // при липсващ сайт няма бонус/наказание за мобилна версия
  });
  it("силен и слаб сайт от противоречиви проверки не се комбинират", () => {
    const r = scoreBusiness({ ...base, websiteStatus: "FOUND", websiteEvidence: true, auditIssues: ["няма HTTPS"], strongModern: true }, s);
    expect(applied(r)).not.toContain("websiteIssues");
    expect(applied(r)).not.toContain("strongModernSite");
  });
  it("UNKNOWN не е fabricated evidence", () => {
    const r = scoreBusiness({ ...base, city: "Русе" }, s);
    expect(r.score).toBe(0);
    expect(r.lines.find((l) => l.rule === "noWebsite")?.why).toMatch(/не е проверен/);
    const noEvidence = scoreBusiness({ ...base, websiteStatus: "NOT_FOUND_AFTER_CHECK", websiteEvidence: false, city: "Русе" }, s);
    expect(applied(noEvidence)).not.toContain("noWebsite");
    const unreachable = scoreBusiness({ ...base, websiteStatus: "UNREACHABLE", city: "Русе" }, s);
    expect(unreachable.score).toBe(0); // timeout ≠ слаб сайт
  });
  it("рейтинг от източник без право за производна употреба не носи точки", () => {
    const r = scoreBusiness({ ...base, rating: 4.9, reviewCount: 300, ratingUsable: false }, s);
    expect(applied(r)).not.toContain("goodReviews");
    const ok = scoreBusiness({ ...base, rating: 4.2, reviewCount: 21, ratingUsable: true }, s);
    expect(applied(ok)).toContain("goodReviews");
    const edge = scoreBusiness({ ...base, rating: 4.2, reviewCount: 20, ratingUsable: true }, s);
    expect(applied(edge)).not.toContain("goodReviews");
  });
  it("тегла от настройките се прилагат", () => {
    const r = scoreBusiness({ ...base, phoneVerified: true, city: "Плевен" }, s);
    expect(r.score).toBe(s.scoreWeights.verifiedPhone + s.scoreWeights.priorityCity);
  });
});
