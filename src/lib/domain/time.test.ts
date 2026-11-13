import { describe, it, expect } from "vitest";
import { toTaipei, isoWeekday, addDays, minutesUntil, timeToMinutes, minutesToTime } from "./time";

// 規格：所有時間以 Asia/Taipei 計算；主機為 UTC
describe("toTaipei 台北時間換算", () => {
  it("UTC 16:30 已是台北隔天 00:30（跨日邊界）", () => {
    const t = toTaipei(new Date("2026-11-13T16:30:00Z"));
    expect(t.date).toBe("2026-11-14");
    expect(t.minutes).toBe(30);
  });

  it("UTC 15:59 仍是台北當天 23:59", () => {
    const t = toTaipei(new Date("2026-11-13T15:59:00Z"));
    expect(t.date).toBe("2026-11-13");
    expect(t.minutes).toBe(23 * 60 + 59);
  });
});

describe("isoWeekday ISO 星期（1=週一 … 7=週日）", () => {
  it.each([
    ["2026-11-09", 1],
    ["2026-11-10", 2],
    ["2026-11-13", 5],
    ["2026-11-14", 6],
    ["2026-11-15", 7],
  ])("%s → %i", (d, w) => {
    expect(isoWeekday(d)).toBe(w);
  });
});

describe("addDays", () => {
  it("跨月", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });
  it("跨年", () => {
    expect(addDays("2026-12-31", 60)).toBe("2027-03-01");
  });
});

describe("minutesUntil 距台北某日某時還有幾分鐘", () => {
  it("台北 10:00 距同日 14:00 = 240", () => {
    const now = new Date("2026-11-14T02:00:00Z"); // 台北 10:00
    expect(minutesUntil(now, "2026-11-14", "14:00")).toBe(240);
  });
  it("已過去為負數", () => {
    const now = new Date("2026-11-14T07:00:00Z"); // 台北 15:00
    expect(minutesUntil(now, "2026-11-14", "14:00")).toBe(-60);
  });
  it("跨日計算", () => {
    const now = new Date("2026-11-13T14:00:00Z"); // 台北 11-13 22:00
    expect(minutesUntil(now, "2026-11-14", "10:00")).toBe(12 * 60);
  });
});

describe("時間字串轉換", () => {
  it("timeToMinutes / minutesToTime", () => {
    expect(timeToMinutes("13:00")).toBe(780);
    expect(minutesToTime(780)).toBe("13:00");
    expect(minutesToTime(600)).toBe("10:00");
  });
});
