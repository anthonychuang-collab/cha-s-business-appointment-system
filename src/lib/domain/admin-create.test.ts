import { describe, it, expect } from "vitest";
import { checkAdminCreate, type SlotBooking } from "./admin-create";
import type { ScheduleData } from "./schedule";

const base: ScheduleData = {
  openings: [{ weekdays: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null }],
  doctors: [{ id: "liao", active: true }, { id: "yan", active: true }],
  doctorShifts: [
    { doctorId: "liao", weekday: 2, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
    { doctorId: "yan", weekday: 4, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
  ],
  blocks: [],
};
// 週二廖、嚴兩位都在班（用來測自動分配）
const twoDoctors: ScheduleData = {
  ...base,
  doctorShifts: [...base.doctorShifts, { doctorId: "yan", weekday: 2, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true }],
};

const TUE = "2026-11-17";
const NOW = new Date("2026-11-14T02:00:00Z"); // 台北 11-14 10:00

const doctorBooking = (doctorId = "liao"): SlotBooking => ({ status: "active", requiresDoctor: true, assignedDoctorId: doctorId });
const nurseBooking: SlotBooking = { status: "active", requiresDoctor: false, assignedDoctorId: null };

function run(over: Partial<Parameters<typeof checkAdminCreate>[0]> = {}) {
  return checkAdminCreate({
    now: NOW, date: TUE, start: "15:00", requiresDoctor: false, requestedDoctorId: null,
    existing: [], overbookReason: "", acknowledgedWarnings: false, schedule: base, ...over,
  });
}

describe("checkAdminCreate 店長新建／超額加開（規格 5.4）", () => {
  describe("空的時段", () => {
    it("僅護理師：一般預約，不算超額、不需原因", () => {
      expect(run()).toEqual({ ok: true, isOverbooked: false, assignedDoctorId: null, warnings: [] });
    });
    it("需醫師：自動安排在班醫師", () => {
      expect(run({ requiresDoctor: true })).toMatchObject({ ok: true, isOverbooked: false, assignedDoctorId: "liao" });
    });
  });

  describe("已有預約 → 超額", () => {
    it("填了原因即可加開", () => {
      expect(run({ existing: [nurseBooking], overbookReason: "同一家人分兩組" })).toMatchObject({ ok: true, isOverbooked: true });
    });
    it("沒填原因 → REASON_REQUIRED", () => {
      expect(run({ existing: [nurseBooking] })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    });
    it("原因只有空白也算沒填", () => {
      expect(run({ existing: [nurseBooking], overbookReason: "   " })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    });
    it("筆數不設上限：已有兩筆仍可加開第三筆", () => {
      expect(run({ existing: [nurseBooking, nurseBooking], overbookReason: "團體" }).ok).toBe(true);
    });
    it("已取消的預約不算占用", () => {
      expect(run({ existing: [{ ...nurseBooking, status: "cancelled" }] })).toMatchObject({ ok: true, isOverbooked: false });
    });
    it.each(["completed", "no_show"] as const)("%s 仍算占用", (status) => {
      expect(run({ existing: [{ ...nurseBooking, status }] })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    });
  });

  describe("醫師撞時段警告", () => {
    const busy = { existing: [doctorBooking()], overbookReason: "VIP", requiresDoctor: true };

    it("同一位醫師已有預約，未確認 → NEEDS_CONFIRMATION", () => {
      expect(run(busy)).toEqual({ ok: false, reason: "NEEDS_CONFIRMATION", warnings: ["DOCTOR_DOUBLE_BOOKED"] });
    });
    it("店長確認後 → 可加開，警告仍附在結果供寫入紀錄", () => {
      expect(run({ ...busy, acknowledgedWarnings: true })).toEqual({
        ok: true, isOverbooked: true, assignedDoctorId: "liao", warnings: ["DOCTOR_DOUBLE_BOOKED"],
      });
    });
    it("原有預約是僅護理師，新的需醫師 → 不警告", () => {
      expect(run({ existing: [nurseBooking], overbookReason: "x", requiresDoctor: true })).toMatchObject({ ok: true, warnings: [] });
    });
    it("原有預約需醫師，新的僅護理師 → 不警告", () => {
      expect(run({ existing: [doctorBooking()], overbookReason: "x" })).toMatchObject({ ok: true, warnings: [] });
    });
    it("兩位醫師在班、廖醫師忙 → 自動排嚴醫師，不警告", () => {
      expect(run({ ...busy, schedule: twoDoctors })).toEqual({ ok: true, isOverbooked: true, assignedDoctorId: "yan", warnings: [] });
    });
    it("兩位都忙 → 排第一位並警告", () => {
      const r = run({ ...busy, existing: [doctorBooking("liao"), doctorBooking("yan")], schedule: twoDoctors });
      expect(r).toEqual({ ok: false, reason: "NEEDS_CONFIRMATION", warnings: ["DOCTOR_DOUBLE_BOOKED"] });
    });
    it("店長指定忙碌的醫師（即使另一位有空）→ 照指定，但要警告", () => {
      expect(run({ ...busy, schedule: twoDoctors, requestedDoctorId: "liao" })).toEqual({
        ok: false, reason: "NEEDS_CONFIRMATION", warnings: ["DOCTOR_DOUBLE_BOOKED"],
      });
    });
    it("已取消的醫師預約不會觸發警告", () => {
      expect(run({ ...busy, existing: [{ ...doctorBooking(), status: "cancelled" }] })).toMatchObject({ ok: true, isOverbooked: false, warnings: [] });
    });
  });

  describe("加開也不能繞過班表", () => {
    it("指定的醫師不在班 → NO_DOCTOR", () => {
      expect(run({ requiresDoctor: true, requestedDoctorId: "yan" })).toEqual({ ok: false, reason: "NO_DOCTOR" });
    });
    it("週一需醫師 → NO_DOCTOR", () => {
      expect(run({ date: "2026-11-16", requiresDoctor: true })).toEqual({ ok: false, reason: "NO_DOCTOR" });
    });
    it("週日 → OUTSIDE_HOURS", () => {
      expect(run({ date: "2026-11-22" })).toEqual({ ok: false, reason: "OUTSIDE_HOURS" });
    });
    it("19:00 → OUTSIDE_HOURS", () => {
      expect(run({ start: "19:00" })).toEqual({ ok: false, reason: "OUTSIDE_HOURS" });
    });
    it("全院封鎖 → BLOCKED（即使填了原因）", () => {
      const schedule: ScheduleData = {
        ...base,
        blocks: [{ weekday: null, specificDate: TUE, start: "15:00", end: "16:00", scope: "clinic", doctorId: null, effectiveFrom: "2026-01-01", effectiveTo: null, active: true }],
      };
      expect(run({ schedule, existing: [nurseBooking], overbookReason: "x" })).toEqual({ ok: false, reason: "BLOCKED" });
    });
  });

  describe("時間", () => {
    it("店長不受 1 小時限制：距開始 30 分鐘仍可", () => {
      const now = new Date("2026-11-17T06:30:00Z"); // 週二 14:30
      expect(run({ now }).ok).toBe(true);
    });
    it("已開始 → STARTED", () => {
      const now = new Date("2026-11-17T07:10:00Z"); // 15:10
      expect(run({ now })).toEqual({ ok: false, reason: "STARTED" });
    });
    it("非整點 → NOT_ON_HOUR", () => {
      expect(run({ start: "15:30" })).toEqual({ ok: false, reason: "NOT_ON_HOUR" });
    });
  });
});
