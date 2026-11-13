import { describe, it, expect } from "vitest";
import { computeSlots, type ScheduleData } from "./slots";

// 規格 5.1 初始設定
const base: ScheduleData = {
  openings: [{ weekdays: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null }],
  doctors: [
    { id: "liao", active: true },
    { id: "yan", active: true },
    { id: "fri", active: true },
  ],
  doctorShifts: [
    { doctorId: "liao", weekday: 2, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
    { doctorId: "yan", weekday: 4, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
    { doctorId: "fri", weekday: 5, start: "10:00", end: "17:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
  ],
  blocks: [],
};

// 台北 2026-11-14（週六）08:00，早於所有測試日期的營業時間
const NOW = new Date("2026-11-14T00:00:00Z");
const MON = "2026-11-16";
const TUE = "2026-11-17";
const WED = "2026-11-18";
const FRI = "2026-11-20";
const SUN = "2026-11-22";

function run(over: Partial<Parameters<typeof computeSlots>[0]> = {}) {
  return computeSlots({ now: NOW, maxDays: 60, date: MON, requiresDoctor: false, occupiedStarts: [], schedule: base, ...over });
}
const avail = (slots: ReturnType<typeof computeSlots>) => slots.filter((s) => s.available).map((s) => s.start);

describe("computeSlots 可約時段（規格 5.2）", () => {
  it("週一僅護理師：九個時段 10:00–18:00，沒有 19:00", () => {
    const slots = run();
    expect(slots.map((s) => s.start)).toEqual(["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    expect(slots.at(-1)!.end).toBe("19:00");
    expect(slots.every((s) => s.available)).toBe(true);
  });

  it("週日休診：沒有任何時段", () => {
    expect(run({ date: SUN })).toEqual([]);
  });

  it("週二需醫師：13:00 前不可，13:00–18:00 可，安排廖醫師", () => {
    const slots = run({ date: TUE, requiresDoctor: true });
    expect(avail(slots)).toEqual(["13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    expect(slots.find((s) => s.start === "10:00")!.reason).toBe("NO_DOCTOR");
    expect(slots.find((s) => s.start === "13:00")!.doctorIds).toEqual(["liao"]);
  });

  it("週五需醫師：最後可約 16:00–17:00", () => {
    const slots = run({ date: FRI, requiresDoctor: true });
    expect(avail(slots).at(-1)).toBe("16:00");
    expect(slots.find((s) => s.start === "17:00")!.reason).toBe("NO_DOCTOR");
  });

  it("週一、週三需醫師：全部不可", () => {
    expect(avail(run({ date: MON, requiresDoctor: true }))).toEqual([]);
    expect(avail(run({ date: WED, requiresDoctor: true }))).toEqual([]);
  });

  it("僅護理師不受醫師出診日限制", () => {
    expect(avail(run({ date: WED })).length).toBe(9);
  });

  it("已被占用的時段為 FULL", () => {
    const slots = run({ occupiedStarts: ["14:00"] });
    expect(slots.find((s) => s.start === "14:00")).toMatchObject({ available: false, reason: "FULL" });
    expect(avail(slots).length).toBe(8);
  });

  it("當天距開始不足 1 小時的時段為 LEAD_TIME", () => {
    const now = new Date("2026-11-16T05:30:00Z"); // 週一 13:30
    const slots = run({ now });
    expect(slots.find((s) => s.start === "14:00")!.reason).toBe("LEAD_TIME");
    expect(slots.find((s) => s.start === "13:00")!.reason).toBe("LEAD_TIME");
    expect(avail(slots)[0]).toBe("15:00");
  });

  it("超過最遠可約天數：沒有任何時段", () => {
    expect(run({ date: "2027-01-14" })).toEqual([]);
    expect(run({ date: "2027-01-13" }).length).toBe(9);
  });

  it("過去日期：沒有任何時段", () => {
    expect(run({ date: "2026-11-13" })).toEqual([]);
  });

  it("全院特定日期封鎖 15:00–17:00", () => {
    const schedule: ScheduleData = { ...base, blocks: [{ specificDate: MON, weekday: null, start: "15:00", end: "17:00", scope: "clinic", doctorId: null, effectiveFrom: "2026-01-01", effectiveTo: null, active: true }] };
    const slots = run({ schedule });
    expect(slots.find((s) => s.start === "15:00")!.reason).toBe("BLOCKED");
    expect(slots.find((s) => s.start === "16:00")!.reason).toBe("BLOCKED");
    expect(slots.find((s) => s.start === "17:00")!.available).toBe(true);
  });

  it("封鎖只蓋到半小時也會讓整個時段不可約", () => {
    const schedule: ScheduleData = { ...base, blocks: [{ specificDate: MON, weekday: null, start: "15:30", end: "16:00", scope: "clinic", doctorId: null, effectiveFrom: "2026-01-01", effectiveTo: null, active: true }] };
    expect(run({ schedule }).find((s) => s.start === "15:00")!.reason).toBe("BLOCKED");
  });

  it("廖醫師請假：需醫師全不可，僅護理師不受影響", () => {
    const schedule: ScheduleData = { ...base, blocks: [{ specificDate: TUE, weekday: null, start: "13:00", end: "19:00", scope: "doctor", doctorId: "liao", effectiveFrom: "2026-01-01", effectiveTo: null, active: true }] };
    expect(avail(run({ date: TUE, requiresDoctor: true, schedule }))).toEqual([]);
    expect(avail(run({ date: TUE, requiresDoctor: false, schedule })).length).toBe(9);
  });

  it("醫師停用：該醫師班表不算", () => {
    const schedule: ScheduleData = { ...base, doctors: base.doctors.map((d) => (d.id === "liao" ? { ...d, active: false } : d)) };
    expect(avail(run({ date: TUE, requiresDoctor: true, schedule }))).toEqual([]);
  });

  it("班表已過截止日：不算", () => {
    const schedule: ScheduleData = { ...base, doctorShifts: base.doctorShifts.map((s) => (s.doctorId === "liao" ? { ...s, effectiveTo: "2026-11-16" } : s)) };
    expect(avail(run({ date: TUE, requiresDoctor: true, schedule }))).toEqual([]);
  });

  it("班表尚未生效：不算", () => {
    const schedule: ScheduleData = { ...base, doctorShifts: base.doctorShifts.map((s) => (s.doctorId === "liao" ? { ...s, effectiveFrom: "2026-11-18" } : s)) };
    expect(avail(run({ date: TUE, requiresDoctor: true, schedule }))).toEqual([]);
  });

  it("同時段兩位醫師：doctorIds 兩位都列出", () => {
    const schedule: ScheduleData = {
      ...base,
      doctorShifts: [...base.doctorShifts, { doctorId: "yan", weekday: 2, start: "15:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true }],
    };
    const slot = run({ date: TUE, requiresDoctor: true, schedule }).find((s) => s.start === "15:00")!;
    expect(slot.doctorIds.sort()).toEqual(["liao", "yan"]);
  });

  it("醫師班表只蓋到半小時的時段不可約（完整一小時才算）", () => {
    const schedule: ScheduleData = { ...base, doctorShifts: [{ doctorId: "liao", weekday: 2, start: "13:30", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true }] };
    const slots = run({ date: TUE, requiresDoctor: true, schedule });
    expect(slots.find((s) => s.start === "13:00")!.reason).toBe("NO_DOCTOR");
    expect(avail(slots)[0]).toBe("14:00");
  });

  it("營業時間調整後動態產生（例如週一改 12:00–17:00）", () => {
    const schedule: ScheduleData = {
      ...base,
      openings: [
        { weekdays: [1], start: "12:00", end: "17:00", effectiveFrom: "2026-11-16", effectiveTo: null },
        { weekdays: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: "2026-11-15" },
        { weekdays: [2, 3, 4, 5, 6], start: "10:00", end: "19:00", effectiveFrom: "2026-11-16", effectiveTo: null },
      ],
    };
    expect(run({ schedule }).map((s) => s.start)).toEqual(["12:00", "13:00", "14:00", "15:00", "16:00"]);
  });

  it("封鎖優先：理由優先序 LEAD_TIME > BLOCKED > FULL > NO_DOCTOR", () => {
    const schedule: ScheduleData = { ...base, blocks: [{ specificDate: TUE, weekday: null, start: "14:00", end: "15:00", scope: "clinic", doctorId: null, effectiveFrom: "2026-01-01", effectiveTo: null, active: true }] };
    const slot = run({ date: TUE, requiresDoctor: true, schedule, occupiedStarts: ["14:00"] }).find((s) => s.start === "14:00")!;
    expect(slot.reason).toBe("BLOCKED");
  });
});
