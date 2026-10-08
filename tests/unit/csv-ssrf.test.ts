import { describe, expect, it } from "vitest";
import { csvSafe, parseCsv, parseEuroCents, toCsv } from "@/domain/csv";
import { stripRestricted } from "@/domain/ingest";
import { nextStage } from "@/domain/outcomes";
import { checkUrlShape, isPublicAddress, resolvePublic, safeFetch, SsrfError } from "@/providers/webAudit";

describe("T40 CSV безопасност", () => {
  it("formula injection се неутрализира", () => {
    for (const v of ["=HYPERLINK(\"x\")", "+1+1", "-2", "@SUM(A1)", "\tx"]) expect(csvSafe(v).startsWith("'")).toBe(true);
    expect(csvSafe("Пицария")).toBe("Пицария");
  });
  it("UTF-8 BOM, кирилица, кавички, телефони с водеща нула като текст", () => {
    const out = toCsv(["Име", "Телефон"], [["Пицария „Мама“, ООД", "0881234567"], ['Казва "здравей"', "+359881234567"]]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain('"Пицария „Мама“, ООД"');
    expect(out).toContain('"Казва ""здравей"""');
    expect(out).toContain("0881234567");
    expect(out).toContain("'+359881234567"); // + в началото би станал формула
    const back = parseCsv(out);
    expect(back.rows[0]!["Име"]).toBe("Пицария „Мама“, ООД");
    expect(back.rows[0]!["Телефон"]).toBe("0881234567");
  });
  it("точка и запетая като разделител и евро суми", () => {
    const p = parseCsv("Business Name;City\nТест;Варна\n");
    expect(p.rows[0]!.City).toBe("Варна");
    expect(parseEuroCents("700")).toBe(70000);
    expect(parseEuroCents("950,50 €")).toBe(95050);
    expect(() => parseEuroCents("abc")).toThrow();
  });
});

describe("T41 ограничено съдържание", () => {
  it("DISPLAY_ONLY полета се изчистват преди запис", () => {
    const c = stripRestricted({ name: "X", city: "Варна", category: "auto", source: "GOOGLE_PLACES", sourceUsageConfirmed: false, contactHistoryState: "UNKNOWN", phone: "0881234567", rating: 4.9, placeId: "ChIJ_test", fieldPolicy: { phone: "DISPLAY_ONLY", rating: "DISPLAY_ONLY", placeId: "ID_ONLY" } });
    expect(c.phone).toBeNull();
    expect(c.rating).toBeNull();
    expect(c.placeId).toBe("ChIJ_test");
    expect("fieldPolicy" in c).toBe(false);
  });
});

describe("T39 SSRF", () => {
  it("непублични адреси (IPv4/IPv6/mapped/metadata) са забранени", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });
  it("схеми, портове, credentials и вътрешни хостове", () => {
    for (const u of ["file:///etc/passwd", "gopher://x", "http://x.bg:8080/", "http://u:p@x.bg/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://intranet.local/"]) expect(() => checkUrlShape(u)).toThrow(SsrfError);
    expect(checkUrlShape("https://example.bg/").hostname).toBe("example.bg");
  });
  it("redirect Location се валидира отново (относителен и абсолютен)", () => {
    const base = new URL("https://public.example/");
    expect(() => checkUrlShape(new URL("http://127.0.0.1/admin", base).toString())).toThrow(SsrfError);
    expect(() => checkUrlShape(new URL("//[fd00::1]/", base).toString())).toThrow(SsrfError);
  });
  it("DNS към частен адрес (вкл. rebinding опит) се блокира преди връзка", async () => {
    await expect(resolvePublic("evil.example", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }])).rejects.toThrow(SsrfError);
    await expect(safeFetch("http://rebind.example/", { resolve: async () => [{ address: "127.0.0.1", family: 4 }] })).rejects.toThrow(SsrfError);
    await expect(safeFetch("http://v6.example/", { resolve: async () => [{ address: "::1", family: 6 }] })).rejects.toThrow(SsrfError);
  });
});

describe("T15/T21 матрица на преходите (pure)", () => {
  it("само напред; WON е краен", () => {
    expect(nextStage("NEW", "SPOKE", true)).toBe("CONTACTED");
    expect(nextStage("QUALIFIED", "SPOKE", true)).toBe("QUALIFIED");
    expect(nextStage("NEW", "NO_ANSWER", false)).toBe("NEW");
    expect(nextStage("NEW", "CALL_BACK", false)).toBe("NEW");
    expect(nextStage("NEW", "CALL_BACK", true)).toBe("CONTACTED");
    expect(nextStage("CONTACTED", "INTERESTED", true)).toBe("QUALIFIED");
    expect(nextStage("CONTACTED", "SEND_OFFER", true)).toBe("PROPOSAL");
    expect(nextStage("PROPOSAL", "DECLINED", true)).toBe("LOST");
    expect(nextStage("QUALIFIED", "DO_NOT_CONTACT", true)).toBe("QUALIFIED"); // DNC ≠ LOST
    expect(nextStage("WON", "NO_ANSWER", false)).toBe("WON");
    expect(nextStage("WON", "DECLINED", true)).toBe("WON");
    expect(nextStage("LOST", "SPOKE", true)).toBe("LOST");
  });
});
