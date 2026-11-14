import { describe, expect, it } from "vitest";
import { checkHour, openingFor, openingRulesFromDays, summarizeOpenings, validateOpeningDays, type ScheduleData } from "./schedule";

const base = (openings: ScheduleData["openings"]): ScheduleData => ({ openings, doctors: [], doctorShifts: [], blocks: [] });

describe("依星期分別設定營業時間", () => {
  const days = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "10:00", end: "19:00" })).concat([{ weekday: 6, start: "10:00", end: "17:00" }]);

  it("相同時間的星期合併成同一條規則，依星期排序", () => {
    expect(openingRulesFromDays(days)).toEqual([
      { weekdays: [1, 2, 3, 4, 5], start: "10:00", end: "19:00", effectiveFrom: "2000-01-01", effectiveTo: null },
      { weekdays: [6], start: "10:00", end: "17:00", effectiveFrom: "2000-01-01", effectiveTo: null },
    ]);
  });

  it("週六 17:00 收診：16:00 可約、17:00 起不在營業時間；週一仍到 19:00", () => {
    const s = base(openingRulesFromDays(days));
    // 2026-11-21 是週六、2026-11-16 是週一
    expect(openingFor(s, "2026-11-21")).toMatchObject({ start: "10:00", end: "17:00" });
    expect(checkHour(s, "2026-11-21", 16 * 60).withinHours).toBe(true);
    expect(checkHour(s, "2026-11-21", 17 * 60).withinHours).toBe(false);
    expect(checkHour(s, "2026-11-16", 18 * 60).withinHours).toBe(true);
    expect(openingFor(s, "2026-11-22")).toBeUndefined(); // 週日休診
  });

  it("顯示文字：連續星期合併成區間", () => {
    expect(summarizeOpenings(openingRulesFromDays(days))).toBe("週一至週五 10:00–19:00；週六 10:00–17:00");
    expect(summarizeOpenings(openingRulesFromDays([{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 3, start: "09:00", end: "12:00" }])))
      .toBe("週一、週三 09:00–12:00");
    expect(summarizeOpenings([])).toBe("");
  });

  it("檢查：整點、結束晚於開始、星期不重複、至少一天", () => {
    expect(validateOpeningDays(days)).toBeNull();
    expect(validateOpeningDays([])).toBe("請至少設定一天營業。");
    expect(validateOpeningDays([{ weekday: 6, start: "10:30", end: "17:00" }])).toBe("營業時間請設定為整點。");
    expect(validateOpeningDays([{ weekday: 6, start: "17:00", end: "10:00" }])).toBe("週六的結束時間需晚於開始時間。");
    expect(validateOpeningDays([{ weekday: 6, start: "10:00", end: "17:00" }, { weekday: 6, start: "10:00", end: "18:00" }])).toBe("週六重複設定。");
    expect(validateOpeningDays([{ weekday: 8, start: "10:00", end: "17:00" }])).toBe("星期不正確。");
  });
});
