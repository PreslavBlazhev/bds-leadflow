import { describe, expect, it } from "vitest";
import { addDays, fmtDate, fmtDateTime, fromLocalInput, localDateOf, offsetMinutes, weekdayOf, zonedToUtc } from "@/lib/time";

describe("T25 Europe/Sofia около DST (без фиксиран offset)", () => {
  it("преди и след 29.03.2026 (лятно време)", () => {
    expect(zonedToUtc("2026-03-28", "08:00").toISOString()).toBe("2026-03-28T06:00:00.000Z"); // UTC+2
    expect(zonedToUtc("2026-03-29", "08:00").toISOString()).toBe("2026-03-29T05:00:00.000Z"); // UTC+3
    expect(offsetMinutes(new Date("2026-03-29T00:30:00Z"))).toBe(120);
    expect(offsetMinutes(new Date("2026-03-29T01:30:00Z"))).toBe(180);
  });
  it("преди и след 25.10.2026 (зимно време)", () => {
    expect(zonedToUtc("2026-10-24", "08:00").toISOString()).toBe("2026-10-24T05:00:00.000Z");
    expect(zonedToUtc("2026-10-25", "08:00").toISOString()).toBe("2026-10-25T06:00:00.000Z");
    expect(zonedToUtc("2026-10-26", "07:00").toISOString()).toBe("2026-10-26T05:00:00.000Z");
  });
  it("localDate е по българско време, не UTC", () => {
    expect(localDateOf(new Date("2026-10-06T21:30:00Z"))).toBe("2026-10-07"); // 00:30 EEST
    expect(localDateOf(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01"); // 00:30 EET
  });
  it("addDays през DST и края на месеца", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("weekday и формати dd.MM.yyyy / 24ч", () => {
    expect(weekdayOf("2026-10-07")).toBe(3);
    expect(weekdayOf("2026-10-11")).toBe(7);
    expect(fmtDate("2026-10-07")).toBe("07.10.2026");
    expect(fmtDateTime(new Date("2026-10-07T15:05:00Z"))).toBe("07.10.2026 18:05");
  });
  it("datetime-local се тълкува като Europe/Sofia", () => {
    expect(fromLocalInput("2026-10-25T11:00").toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(() => fromLocalInput("невалидно")).toThrow();
  });
});
