import { describe, expect, it } from "vitest";
import type { Appointment } from "@/lib/data/types";
import { buildDigestEmail, buildInstantEmail, describeChanges, snapshotOf, type Names } from "./email";

const names: Names = {
  itemName: (id) => ({ i1: "療程諮詢", i2: "疫苗" })[id] ?? "（已刪除項目）",
  doctorName: (id) => (id === "d1" ? "廖醫師" : "—"),
  salespersonName: (id) => ({ s1: "業務甲", s2: "業務乙" })[id] ?? "—",
};

const appt: Appointment = {
  id: "a1", code: "PI-20261117-001", customerName: "王小明", phone: "0912-345-678", phoneNormalized: "0912345678",
  date: "2026-11-17", start: "14:00", end: "15:00", itemId: "i1", partySize: 2, requiresDoctor: true, assignedDoctorId: "d1",
  preferredDoctorNote: "", careNote: "對花生過敏，需輪椅協助", salespersonId: "s1", status: "active", isOverbooked: false, overbookReason: "",
  conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "", createdBy: "u1", updatedBy: "u1",
  createdAt: "2026-11-13T08:00:00.000Z", updatedAt: "2026-11-13T08:00:00.000Z", cancelledAt: null, version: 1,
};

describe("describeChanges", () => {
  it("把 id 轉成名稱、布林與狀態轉成中文", () => {
    const lines = describeChanges({
      itemId: { from: "i1", to: "i2" },
      requiresDoctor: { from: true, to: false },
      assignedDoctorId: { from: "d1", to: null },
      salespersonId: { from: "s1", to: "s2" },
      status: { from: "active", to: "cancelled" },
      partySize: { from: 2, to: 3 },
    }, names);
    expect(lines).toEqual([
      { label: "項目", from: "療程諮詢", to: "疫苗" },
      { label: "醫師需求", from: "需醫師", to: "僅護理師" },
      { label: "安排醫師", from: "廖醫師", to: "—" },
      { label: "負責業務", from: "業務甲", to: "業務乙" },
      { label: "狀態", from: "已預約", to: "已取消" },
      { label: "人數", from: "2 人", to: "3 人" },
    ]);
  });

  it("照護備註只寫已修改，不帶任何內容", () => {
    const lines = describeChanges({ careNote: "（已修改）" }, names);
    expect(lines).toEqual([{ label: "照護備註", from: "", to: "已修改（內容請登入後台查看）" }]);
    // 就算呼叫端誤傳原文，也不會出現在信中
    const leaked = describeChanges({ careNote: { from: "舊的過敏史", to: "新的過敏史" } }, names);
    expect(JSON.stringify(leaked)).not.toContain("過敏史");
  });

  it("內部欄位與看不懂的格式略過", () => {
    expect(describeChanges({ end: { from: "14:00", to: "15:00" }, cancelledAt: { from: null, to: "x" }, version: 3, phone: "bad" }, names)).toEqual([]);
  });
});

describe("buildInstantEmail", () => {
  const base = {
    event: "sales_edit_within_4h" as const, summary: "業務甲 於 4 小時內修改：2026-11-17 14:00 王小明", actorName: "業務甲",
    createdAt: "2026-11-17T03:30:00.000Z", appointmentId: "a1",
  };

  it("含事件、操作者、台北時間、預約摘要、差異與後台連結", () => {
    const m = buildInstantEmail({
      ...base, baseUrl: "https://booking.example.com/",
      payload: { appointment: snapshotOf(appt, names), changes: describeChanges({ partySize: { from: 1, to: 2 }, careNote: "（已修改）" }, names) },
    });
    expect(m.subject).toBe("[PURE IN 預約] 業務於 4 小時內修改｜2026-11-17 14:00 PI-20261117-001");
    for (const s of ["事件：業務於 4 小時內修改", "操作者：業務甲", "時間：2026-11-17 11:30", "日期時段：2026-11-17 14:00–15:00", "王小明（0912-345-678）",
      "需醫師：廖醫師", "人數：1 人 → 2 人", "照護備註：已修改", "https://booking.example.com/admin/appointments/a1"]) {
      expect(m.text).toContain(s);
    }
    expect(m.html).toContain('href="https://booking.example.com/admin/appointments/a1"');
  });

  it("任何情況下都不含照護備註原文", () => {
    const m = buildInstantEmail({ ...base, payload: { appointment: snapshotOf(appt, names), changes: describeChanges({ careNote: "（已修改）" }, names) } });
    expect(m.text + m.html).not.toContain("花生");
  });

  it("沒有設定網址時改寫請登入後台", () => {
    const m = buildInstantEmail({ ...base, payload: {} });
    expect(m.text).toContain("詳細內容請登入後台查看。");
    expect(m.html).not.toContain("href=");
  });

  it("重複電話列出同電話的其他預約", () => {
    const other = snapshotOf({ ...appt, code: "PI-20261118-002", date: "2026-11-18", salespersonId: "s2" }, names);
    const m = buildInstantEmail({ ...base, event: "duplicate_phone", payload: { appointment: snapshotOf(appt, names), related: [other] } });
    expect(m.text).toContain("【同一電話的其他預約】");
    expect(m.text).toContain("PI-20261118-002　2026-11-18 14:00　王小明　療程諮詢　負責業務 業務乙");
  });

  it("HTML 會跳脫使用者輸入", () => {
    const m = buildInstantEmail({ ...base, payload: { appointment: snapshotOf({ ...appt, customerName: '<img src=x onerror="alert(1)">' }, names) } });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img");
  });
});

describe("buildDigestEmail", () => {
  const item = (createdAt: string, summary: string, over = {}) => ({
    event: "sales_edit" as const, summary, actorName: "業務甲", createdAt, appointmentId: "a1",
    payload: { appointment: snapshotOf(appt, names), changes: describeChanges({ partySize: { from: 1, to: 2 }, careNote: "（已修改）" }, names) },
    ...over,
  });

  it("依時間排序列出每件事、差異與連結，主旨含日期與件數", () => {
    const m = buildDigestEmail({
      date: "2026-11-17", baseUrl: "https://booking.example.com",
      items: [item("2026-11-17T09:00:00.000Z", "第二件"), item("2026-11-17T01:00:00.000Z", "第一件")],
    });
    expect(m.subject).toBe("[PURE IN 預約] 每日日報｜2026-11-17（2 件）");
    expect(m.text.indexOf("第一件")).toBeLessThan(m.text.indexOf("第二件"));
    expect(m.text).toContain("1. 2026-11-17 09:00　業務修改預約　操作者：業務甲");
    expect(m.text).toContain("   PI-20261117-001　2026-11-17 14:00–15:00　療程諮詢・2 人　負責業務 業務甲");
    expect(m.text).toContain("   - 人數：1 人 → 2 人");
    expect(m.text).toContain("   - 照護備註：已修改");
    expect(m.text).toContain("https://booking.example.com/admin/appointments/a1");
    expect(m.text + m.html).not.toContain("花生");
  });

  it("跳脫 HTML、沒有網址時不放連結", () => {
    const m = buildDigestEmail({ date: "2026-11-17", items: [item("2026-11-17T01:00:00.000Z", "<script>x</script>")] });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("href=");
  });
});
