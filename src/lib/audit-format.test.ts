import { describe, expect, it } from "vitest";
import { actionLabel, auditLines } from "./audit-format";
import type { Names } from "@/lib/notify/email";

const names: Names = {
  itemName: (id) => (id === "i1" ? "療程諮詢" : "疫苗"),
  doctorName: (id) => (id === "d1" ? "廖醫師" : "—"),
  salespersonName: (id) => (id === "s1" ? "業務甲" : "業務乙"),
};

describe("actionLabel", () => {
  it("依對象類型給中文名稱；未知動作原樣顯示", () => {
    expect(actionLabel("appointment", "status:no_show")).toBe("標記未到");
    expect(actionLabel("item", "create")).toBe("新增項目");
    expect(actionLabel("account", "create")).toBe("建立帳號");
    expect(actionLabel("schedule", "block-create")).toBe("新增封鎖／請假");
    expect(actionLabel("account", "something-new")).toBe("something-new");
  });
});

describe("auditLines", () => {
  it("預約修改：名稱解析、照護備註只寫已修改", () => {
    expect(auditLines({
      entityType: "appointment", action: "update",
      changes: { itemId: { from: "i1", to: "i2" }, salespersonId: { from: "s1", to: "s2" }, careNote: "（已修改）" },
    }, names)).toEqual(["項目：療程諮詢 → 疫苗", "照護備註：已修改（內容請登入後台查看）", "負責業務：業務甲 → 業務乙"]);
  });

  it("預約：加開警告與班表重算原因", () => {
    expect(auditLines({ entityType: "appointment", action: "overbook", changes: { warnings: ["DOCTOR_DOUBLE_BOOKED"] } }, names))
      .toEqual(["警告：醫師同時段已有其他預約（已確認）"]);
    expect(auditLines({
      entityType: "appointment", action: "conflict-recompute",
      changes: { conflictStatus: { from: "none", to: "conflict" }, reasons: ["BLOCKED", "DOCTOR_UNAVAILABLE"] },
    }, names)).toEqual(["衝突狀態：正常 → 需處理", "原因：全院封鎖、醫師請假或不在班"]);
  });

  it("設定、帳號、項目、班表", () => {
    expect(auditLines({
      entityType: "settings", action: "update",
      changes: { maxDays: { from: 60, to: 90 }, "notifyMode.sales_edit": { from: "digest", to: "instant" } },
    }, names)).toEqual(["最遠可約天數：60 天 → 90 天", "通知方式（一般修改）：日報 → 即時信"]);
    expect(auditLines({ entityType: "account", action: "create", changes: { name: "王店長", loginName: "boss", role: "admin" } }, names))
      .toEqual(["名稱：王店長", "登入帳號：boss", "角色：店長"]);
    expect(auditLines({ entityType: "item", action: "update", changes: { name: "疫苗", active: { from: true, to: false } } }, names))
      .toEqual(["名稱：疫苗", "狀態：啟用 → 停用"]);
    expect(auditLines({ entityType: "schedule", action: "shift-update", changes: { detail: { from: "廖醫師 週二 13:00–19:00", to: "廖醫師 週二 14:00–19:00" } } }, names))
      .toEqual(["內容：廖醫師 週二 13:00–19:00 → 廖醫師 週二 14:00–19:00"]);
  });

  it("以指令重設密碼", () => {
    expect(auditLines({ entityType: "account", action: "reset-password", changes: { name: "陳店長", via: "command" } }, names))
      .toEqual(["名稱：陳店長", "方式：以指令重設（忘記密碼救援）"]);
  });

  it("沒有內容時回傳空陣列", () => {
    expect(auditLines({ entityType: "account", action: "reset-password", changes: {} }, names)).toEqual([]);
  });
});
