import { describe, expect, it } from "vitest";
import { identifiersFor, isPlatformUrl, normalizeDomain, normalizeName, normalizePhone, safeHttpUrl } from "@/domain/identity";

// Статични, валидно форматирани fixtures само за нормализация. Никога не се набират.
describe("T06 нормализация на телефони", () => {
  it("+359, 00359 и локален формат дават един identifier", () => {
    const variants = ["+359 88 123 4567", "00359881234567", "0881234567", "088 123 45 67", "(088) 123-4567", "'0881234567"];
    const out = new Set(variants.map((v) => normalizePhone(v)?.normalized));
    expect(out).toEqual(new Set(["+359881234567"]));
  });
  it("стационарен варненски номер", () => {
    expect(normalizePhone("052 600 000")?.normalized).toBe(normalizePhone("+35952600000")?.normalized);
  });
  it("невалиден формат се маркира INVALID (валиден формат ≠ действащ номер)", () => {
    expect(normalizePhone("12")?.kind).toBe("INVALID");
    expect(normalizePhone("")).toBeNull();
  });
  it("synthetic demo namespace не минава през production валидатора", () => {
    expect(normalizePhone("DEMO-12")).toEqual({ raw: "DEMO-12", normalized: "DEMO-0012", kind: "DEMO_SYNTHETIC" });
    expect(normalizePhone("DEMO-0012")?.normalized).toBe("DEMO-0012");
  });
});

describe("домейни", () => {
  it("протокол/www/trailing slash се нормализират до регистриран домейн", () => {
    expect(normalizeDomain("http://www.Pizza-Test.bg/")).toBe("pizza-test.bg");
    expect(normalizeDomain("https://menu.pizza-test.bg/path?x=1")).toBe("pizza-test.bg");
    expect(normalizeDomain("pizza-test.bg")).toBe("pizza-test.bg");
    expect(normalizeDomain("https://shop.example.co.uk")).toBe("example.co.uk");
  });
  it("общи платформи НЕ са идентификатор на бизнес", () => {
    expect(normalizeDomain("https://www.facebook.com/pizzeria.one")).toBeNull();
    expect(normalizeDomain("https://m.facebook.com/pizzeria.two")).toBeNull();
    expect(normalizeDomain("https://instagram.com/x")).toBeNull();
    expect(isPlatformUrl("https://facebook.com/a")).toBe(true);
  });
  it("PSL private суфикси: различни github.io сайтове са различни", () => {
    expect(normalizeDomain("https://a.github.io")).not.toBe(normalizeDomain("https://b.github.io"));
  });
  it("опасни схеми и credentials се отхвърлят", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("https://user:pw@x.bg")).toBeNull();
    expect(safeHttpUrl("ftp://x.bg")).toBeNull();
  });
});

describe("имена и identifiers", () => {
  it("юридически суфикси, кавички и регистър", () => {
    expect(normalizeName("„Пицария Мама“ ЕООД")).toBe(normalizeName("пицария мама"));
  });
  it("identifiersFor включва силни и слаби сигнали", () => {
    const ids = identifiersFor({ name: "Тест", city: "Варна", phone: "0881234567", website: "https://www.test.bg", eik: "123456789" });
    expect(ids.map((i) => i.type).sort()).toEqual(["DOMAIN", "EIK", "NAME_CITY", "PHONE"]);
    expect(ids.find((i) => i.type === "NAME_CITY")?.strong).toBe(false);
  });
});
