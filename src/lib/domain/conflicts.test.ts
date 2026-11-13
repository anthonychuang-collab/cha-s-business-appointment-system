import { describe, it, expect } from "vitest";
import { evaluateConflict, recomputeConflicts, type ConflictInput } from "./conflicts";
import type { BlockRule, ScheduleData } from "./slots";

// 規格 5.1 初始班表
const base: ScheduleData = {
  openings: [{ weekdays: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null }],
  doctors: [
    { id: "liao", active: true },
    { id: "yan", active: true },
  ],
  doctorShifts: [
    { doctorId: "liao", weekday: 2, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
    { doctorId: "yan", weekday: 4, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
  ],
  blocks: [],
};

const TUE = "2026-11-17";

const block = (over: Partial<BlockRule>): BlockRule => ({
  weekday: null, specificDate: TUE, start: "13:00", end: "19:00", scope: "clinic", doctorId: null,
  effectiveFrom: "2026-01-01", effectiveTo: null, active: true, ...over,
});
const withBlocks = (...blocks: BlockRule[]): ScheduleData => ({ ...base, blocks });
const liaoLeave = block({ scope: "doctor", doctorId: "liao" });

// 週二 15:00，需要醫師，安排廖醫師
const appt = (over: Partial<ConflictInput> = {}): ConflictInput => ({
  date: TUE, start: "15:00", requiresDoctor: true, assignedDoctorId: "liao",
  conflictStatus: "none", keptReasons: [], ...over,
});

describe("evaluateConflict 單筆預約是否衝突（規格 5.5）", () => {
  describe("符合班表 → 沒有衝突", () => {
    it("班表沒變", () => {
      expect(evaluateConflict(appt(), base)).toMatchObject({ conflictStatus: "none", reasons: [] });
    });
    it("醫師只請 13:00–14:00，不影響 15:00", () => {
      const s = withBlocks(block({ scope: "doctor", doctorId: "liao", start: "13:00", end: "14:00" }));
      expect(evaluateConflict(appt(), s).conflictStatus).toBe("none");
    });
    it("僅護理師的預約，醫師請假不影響", () => {
      expect(evaluateConflict(appt({ requiresDoctor: false, assignedDoctorId: null }), withBlocks(liaoLeave)).conflictStatus).toBe("none");
    });
    it("別的醫師請假，不影響", () => {
      expect(evaluateConflict(appt(), withBlocks(block({ scope: "doctor", doctorId: "yan" }))).conflictStatus).toBe("none");
    });
  });

  describe("三種衝突原因", () => {
    it("安排的醫師請假 → DOCTOR_UNAVAILABLE", () => {
      expect(evaluateConflict(appt(), withBlocks(liaoLeave))).toMatchObject({ conflictStatus: "conflict", reasons: ["DOCTOR_UNAVAILABLE"] });
    });
    it("安排的醫師被停用 → DOCTOR_UNAVAILABLE", () => {
      const s: ScheduleData = { ...base, doctors: [{ id: "liao", active: false }, { id: "yan", active: true }] };
      expect(evaluateConflict(appt(), s).reasons).toEqual(["DOCTOR_UNAVAILABLE"]);
    });
    it("安排的醫師班表截止 → DOCTOR_UNAVAILABLE", () => {
      const s: ScheduleData = { ...base, doctorShifts: base.doctorShifts.map((x) => (x.doctorId === "liao" ? { ...x, effectiveTo: "2026-11-16" } : x)) };
      expect(evaluateConflict(appt(), s).reasons).toEqual(["DOCTOR_UNAVAILABLE"]);
    });
    it("安排的醫師班表縮短到 15:30 才開始 → DOCTOR_UNAVAILABLE（要完整一小時）", () => {
      const s: ScheduleData = { ...base, doctorShifts: base.doctorShifts.map((x) => (x.doctorId === "liao" ? { ...x, start: "15:30" } : x)) };
      expect(evaluateConflict(appt(), s).reasons).toEqual(["DOCTOR_UNAVAILABLE"]);
    });
    it("全院封鎖 15:00–16:00 → BLOCKED", () => {
      expect(evaluateConflict(appt(), withBlocks(block({ start: "15:00", end: "16:00" }))).reasons).toEqual(["BLOCKED"]);
    });
    it("營業時間縮短為 10:00–15:00 → OUTSIDE_HOURS", () => {
      const s: ScheduleData = { ...base, openings: [{ ...base.openings[0], end: "15:00" }] };
      expect(evaluateConflict(appt({ requiresDoctor: false, assignedDoctorId: null }), s).reasons).toEqual(["OUTSIDE_HOURS"]);
    });
    it("週二改成休診 → OUTSIDE_HOURS", () => {
      const s: ScheduleData = { ...base, openings: [{ ...base.openings[0], weekdays: [1, 3, 4, 5, 6] }] };
      expect(evaluateConflict(appt({ requiresDoctor: false, assignedDoctorId: null }), s).reasons).toEqual(["OUTSIDE_HOURS"]);
    });
    it("多個原因同時存在，全部列出", () => {
      const s = withBlocks(liaoLeave, block({ start: "15:00", end: "16:00" }));
      expect(evaluateConflict(appt(), s).reasons).toEqual(["BLOCKED", "DOCTOR_UNAVAILABLE"]);
    });
  });

  describe("安排的醫師不在，但同時段有別的醫師", () => {
    it("仍算衝突（不自動換醫師），但列出可替代的醫師", () => {
      const s: ScheduleData = {
        ...withBlocks(liaoLeave),
        doctorShifts: [...base.doctorShifts, { doctorId: "yan", weekday: 2, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true }],
      };
      expect(evaluateConflict(appt(), s)).toMatchObject({ conflictStatus: "conflict", reasons: ["DOCTOR_UNAVAILABLE"], alternativeDoctorIds: ["yan"] });
    });
  });

  describe("衝突自動解除", () => {
    it("原本衝突，班表改回後 → none", () => {
      expect(evaluateConflict(appt({ conflictStatus: "conflict" }), base)).toMatchObject({ conflictStatus: "none", reasons: [] });
    });
  });

  describe("店長標記「保留」", () => {
    const kept = appt({ conflictStatus: "kept", keptReasons: ["DOCTOR_UNAVAILABLE"] });

    it("原因沒變 → 維持保留", () => {
      expect(evaluateConflict(kept, withBlocks(liaoLeave))).toMatchObject({ conflictStatus: "kept", reasons: ["DOCTOR_UNAVAILABLE"] });
    });
    it("出現新原因 → 重新標成衝突", () => {
      const s = withBlocks(liaoLeave, block({ start: "15:00", end: "16:00" }));
      expect(evaluateConflict(kept, s)).toMatchObject({ conflictStatus: "conflict", reasons: ["BLOCKED", "DOCTOR_UNAVAILABLE"] });
    });
    it("原因變少但還有一個是保留過的 → 維持保留", () => {
      const keptTwo = appt({ conflictStatus: "kept", keptReasons: ["BLOCKED", "DOCTOR_UNAVAILABLE"] });
      expect(evaluateConflict(keptTwo, withBlocks(liaoLeave)).conflictStatus).toBe("kept");
    });
    it("已經符合規則 → 恢復正常", () => {
      expect(evaluateConflict(kept, base)).toMatchObject({ conflictStatus: "none", reasons: [] });
    });
  });
});

describe("recomputeConflicts 班表異動後批次重算", () => {
  // 台北 2026-11-14 10:00
  const NOW = new Date("2026-11-14T02:00:00Z");
  const row = (id: string, over: Partial<ConflictInput> & { status?: "active" | "completed" | "no_show" | "cancelled" } = {}) => ({
    id, status: "active" as const, ...appt(), ...over,
  });

  it("只回傳狀態有變的預約（給資料庫更新與通知用）", () => {
    const rows = [row("a"), row("b", { requiresDoctor: false, assignedDoctorId: null })];
    const changes = recomputeConflicts({ now: NOW, appointments: rows, schedule: withBlocks(liaoLeave) });
    expect(changes).toEqual([{ id: "a", from: "none", to: "conflict", reasons: ["DOCTOR_UNAVAILABLE"] }]);
  });

  it("自動解除也會回傳", () => {
    const changes = recomputeConflicts({ now: NOW, appointments: [row("a", { conflictStatus: "conflict" })], schedule: base });
    expect(changes).toEqual([{ id: "a", from: "conflict", to: "none", reasons: [] }]);
  });

  it("沒有變化 → 空陣列", () => {
    expect(recomputeConflicts({ now: NOW, appointments: [row("a")], schedule: base })).toEqual([]);
  });

  it.each(["cancelled", "completed", "no_show"] as const)("狀態 %s 不重算", (status) => {
    expect(recomputeConflicts({ now: NOW, appointments: [row("a", { status })], schedule: withBlocks(liaoLeave) })).toEqual([]);
  });

  it("已開始或已過去的預約不重算", () => {
    const past = row("a", { date: "2026-11-10" });
    const started = row("b", { date: "2026-11-14", start: "10:00", requiresDoctor: false, assignedDoctorId: null });
    const s: ScheduleData = { ...base, openings: [] }; // 全部停業
    expect(recomputeConflicts({ now: NOW, appointments: [past, started], schedule: s })).toEqual([]);
  });

  it("同時段兩筆（超額）本身不算衝突", () => {
    const rows = [row("a"), row("b")];
    expect(recomputeConflicts({ now: NOW, appointments: rows, schedule: base })).toEqual([]);
  });
});
