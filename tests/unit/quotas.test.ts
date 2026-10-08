import { describe, expect, it } from "vitest";
import { selectWithQuotas } from "@/domain/batch";
import type { ScoredCandidate } from "@/domain/eligibility";
import { DEFAULT_SETTINGS } from "@/domain/settings";

function pool(spec: Record<string, number>): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  let n = 0;
  for (const [city, count] of Object.entries(spec)) for (let i = 0; i < count; i++) out.push({ b: { id: `id${String(n++).padStart(4, "0")}`, city } as never, score: { score: 50, raw: 50, ruleVersion: "t", lines: [] } });
  return out;
}

describe("T14 квоти само за разрешени градове", () => {
  it("15 Варна / 5 Плевен; без избрани други → 5-те места се преразпределят към Варна/Плевен с обяснение", () => {
    const sel = selectWithQuotas(pool({ Варна: 40, Плевен: 40, Русе: 40 }), DEFAULT_SETTINGS, 25);
    const by = (c: string) => sel.picked.filter((p) => p.c.b.city === c).length;
    expect(sel.picked).toHaveLength(25);
    expect(by("Русе")).toBe(0); // никакво скрито национално разширяване
    expect(by("Варна") + by("Плевен")).toBe(25);
    expect(sel.notes.join(" ")).toMatch(/Няма избрани други градове/);
  });
  it("избрани други градове получават своята квота", () => {
    const s = { ...DEFAULT_SETTINGS, otherCities: ["Русе"] };
    const sel = selectWithQuotas(pool({ Варна: 40, Плевен: 40, Русе: 40, Бургас: 40 }), s, 25);
    expect(sel.picked.filter((p) => p.c.b.city === "Русе")).toHaveLength(5);
    expect(sel.picked.filter((p) => p.c.b.city === "Бургас")).toHaveLength(0);
    expect(sel.plan.Варна!.taken).toBe(15);
  });
  it("недостиг в Плевен се допълва от Варна и се обяснява", () => {
    const sel = selectWithQuotas(pool({ Варна: 40, Плевен: 2 }), DEFAULT_SETTINGS, 25);
    expect(sel.picked).toHaveLength(25);
    expect(sel.notes.join(" ")).toMatch(/Плевен: само 2/);
  });
  it("общ недостиг → по-малко от целта, без дубликати", () => {
    const sel = selectWithQuotas(pool({ Варна: 10, Плевен: 7 }), DEFAULT_SETTINGS, 25);
    expect(sel.picked).toHaveLength(17);
    expect(new Set(sel.picked.map((p) => p.c.b.id)).size).toBe(17);
  });
});
