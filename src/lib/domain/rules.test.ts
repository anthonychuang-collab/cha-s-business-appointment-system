import { describe, it, expect } from "vitest";
import { checkSalesCreate, checkSalesEdit, type ExistingAppointment } from "./rules";

// 台北 2026-11-14（週六）10:00
const NOW = new Date("2026-11-14T02:00:00Z");
const MAX_DAYS = 60;

describe("checkSalesCreate 業務新建預約（規格 5.3）", () => {
  it("距開始剛好 60 分鐘可以建立", () => {
    expect(checkSalesCreate({ now: NOW, date: "2026-11-14", start: "11:00", maxDays: MAX_DAYS }).ok).toBe(true);
  });

  it("距開始不足 60 分鐘不可建立", () => {
    const now = new Date("2026-11-14T02:01:00Z"); // 10:01
    const r = checkSalesCreate({ now, date: "2026-11-14", start: "11:00", maxDays: MAX_DAYS });
    expect(r).toEqual({ ok: false, reason: "LEAD_TIME" });
  });

  it("已過去的時段不可建立", () => {
    const r = checkSalesCreate({ now: NOW, date: "2026-11-13", start: "15:00", maxDays: MAX_DAYS });
    expect(r).toEqual({ ok: false, reason: "LEAD_TIME" });
  });

  it("今天＋60 天當天可以", () => {
    expect(checkSalesCreate({ now: NOW, date: "2027-01-13", start: "10:00", maxDays: MAX_DAYS }).ok).toBe(true);
  });

  it("超過最遠可約天數不可", () => {
    const r = checkSalesCreate({ now: NOW, date: "2027-01-14", start: "10:00", maxDays: MAX_DAYS });
    expect(r).toEqual({ ok: false, reason: "TOO_FAR" });
  });

  it("非整點不可", () => {
    const r = checkSalesCreate({ now: NOW, date: "2026-11-16", start: "10:30", maxDays: MAX_DAYS });
    expect(r).toEqual({ ok: false, reason: "NOT_ON_HOUR" });
  });
});

function appt(over: Partial<ExistingAppointment> = {}): ExistingAppointment {
  return { date: "2026-11-14", start: "15:00", status: "active", conflictStatus: "none", ...over };
}

describe("checkSalesEdit 業務修改自己的預約（規格 5.3）", () => {
  describe("4 小時以前", () => {
    // 15:00 的預約，現在 10:00 → 300 分鐘
    it("可以改期到 1 小時後的新時段", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt(), changes: { time: { date: "2026-11-14", start: "11:00" } } });
      expect(r.ok).toBe(true);
    });

    it("改期的新時段不足 1 小時不可", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt(), changes: { time: { date: "2026-11-14", start: "10:00" } } });
      expect(r).toMatchObject({ ok: false, reason: "LEAD_TIME" });
    });

    it("可以取消、改項目、改醫師需求", () => {
      for (const changes of [{ cancel: true as const }, { itemId: "x" }, { requiresDoctor: true }]) {
        expect(checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt(), changes }).ok).toBe(true);
      }
    });

    it("改基本欄位不觸發 4 小時內通知", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt(), changes: { phone: "0912000000" } });
      expect(r).toEqual({ ok: true, notifyWithin4h: false });
    });
  });

  describe("邊界：剛好 4 小時", () => {
    it("剛好 240 分鐘仍可取消", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt({ start: "14:00" }), changes: { cancel: true } });
      expect(r.ok).toBe(true);
    });
    it("239 分鐘不可取消", () => {
      const now = new Date("2026-11-14T02:01:00Z");
      const r = checkSalesEdit({ now, maxDays: MAX_DAYS, appointment: appt({ start: "14:00" }), changes: { cancel: true } });
      expect(r).toMatchObject({ ok: false, reason: "WITHIN_4H" });
    });
  });

  describe("4 小時內", () => {
    const soon = appt({ start: "12:00" }); // 120 分鐘

    it.each([
      ["改期", { time: { date: "2026-11-16", start: "10:00" } }],
      ["取消", { cancel: true as const }],
      ["改項目", { itemId: "x" }],
      ["改醫師需求", { requiresDoctor: false }],
    ])("%s 不可", (_label, changes) => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: soon, changes });
      expect(r).toMatchObject({ ok: false, reason: "WITHIN_4H" });
    });

    it.each([
      ["姓名", { customerName: "王小明" }],
      ["電話", { phone: "0912000000" }],
      ["備註", { careNote: "怕痛" }],
      ["人數", { partySize: 2 }],
    ])("改%s 可以，並觸發 4 小時內通知", (_label, changes) => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: soon, changes });
      expect(r).toEqual({ ok: true, notifyWithin4h: true });
    });

    it("基本欄位與受限欄位一起改，整筆拒絕", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: soon, changes: { phone: "0912000000", cancel: true } });
      expect(r).toMatchObject({ ok: false, reason: "WITHIN_4H" });
    });
  });

  describe("衝突預約例外", () => {
    const conflict = appt({ start: "12:00", conflictStatus: "conflict" });

    it("4 小時內可改期", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: conflict, changes: { time: { date: "2026-11-16", start: "10:00" } } });
      expect(r.ok).toBe(true);
    });
    it("4 小時內可取消", () => {
      expect(checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: conflict, changes: { cancel: true } }).ok).toBe(true);
    });
    it("4 小時內可改成僅護理師", () => {
      expect(checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: conflict, changes: { requiresDoctor: false } }).ok).toBe(true);
    });
    it("4 小時內不可改成需醫師", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: conflict, changes: { requiresDoctor: true } });
      expect(r).toMatchObject({ ok: false, reason: "WITHIN_4H" });
    });
    it("4 小時內仍不可改項目", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: conflict, changes: { itemId: "x" } });
      expect(r).toMatchObject({ ok: false, reason: "WITHIN_4H" });
    });
    it("已標記保留的預約不再享有例外", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt({ start: "12:00", conflictStatus: "kept" }), changes: { cancel: true } });
      expect(r).toMatchObject({ ok: false, reason: "WITHIN_4H" });
    });
    it("改期的新時段仍須 1 小時以上", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: conflict, changes: { time: { date: "2026-11-14", start: "10:00" } } });
      expect(r).toMatchObject({ ok: false, reason: "LEAD_TIME" });
    });
  });

  describe("一律禁止", () => {
    it("業務不可改負責業務", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt(), changes: { salespersonId: "other" } });
      expect(r).toMatchObject({ ok: false, reason: "FORBIDDEN_FIELD" });
    });
    it("已開始的預約不可做任何修改（含衝突預約）", () => {
      const now = new Date("2026-11-14T07:10:00Z"); // 15:10
      for (const conflictStatus of ["none", "conflict"] as const) {
        const r = checkSalesEdit({ now, maxDays: MAX_DAYS, appointment: appt({ conflictStatus }), changes: { careNote: "x" } });
        expect(r).toMatchObject({ ok: false, reason: "STARTED" });
      }
    });
    it.each(["cancelled", "completed", "no_show"] as const)("狀態為 %s 不可修改", (status) => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt({ status }), changes: { careNote: "x" } });
      expect(r).toMatchObject({ ok: false, reason: "NOT_ACTIVE" });
    });
    it("沒有任何變更", () => {
      const r = checkSalesEdit({ now: NOW, maxDays: MAX_DAYS, appointment: appt(), changes: {} });
      expect(r).toMatchObject({ ok: false, reason: "NO_CHANGES" });
    });
  });
});
