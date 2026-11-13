/**
 * 操作紀錄：各種異動確實寫入可讀的內容，查詢篩選（日期以台北時間切日、對象、動作、操作者、關鍵字）與分頁。
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetTestDatabase, TEST_URL as url } from "./helpers";

if (url) process.env.DATABASE_URL = url;

type User = import("@/lib/data/types").UserAccount;

describe.skipIf(!url)("操作紀錄（TEST_DATABASE_URL）", () => {
  let booking: typeof import("@/lib/booking");
  let admin: typeof import("@/lib/admin");
  let repo: typeof import("@/lib/data/repo");
  let dbm: typeof import("@/lib/data/db");
  let fmt: typeof import("@/lib/audit-format");
  let raw: postgres.Sql;
  let boss: User, sales: User;
  let sp: string, itemId: string, apptId: string, apptCode: string;

  function bookableDate(offset = 3): string {
    const d = new Date(Date.now() + 8 * 3_600_000);
    d.setUTCDate(d.getUTCDate() + offset);
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const search = (f: import("@/lib/data/repo").AuditFilter, limit = 100, offset = 0) => repo.searchAudit(dbm.sql(), f, limit, offset);
  const names = async () => booking.namesOf(await repo.loadRef(dbm.sql()));

  beforeAll(async () => {
    raw = await resetTestDatabase();
    [booking, admin, repo, dbm, fmt] = await Promise.all([
      import("@/lib/booking"), import("@/lib/admin"), import("@/lib/data/repo"), import("@/lib/data/db"), import("@/lib/audit-format"),
    ]);
    const q = dbm.sql();
    const mk = async (loginName: string, role: User["role"], displayName: string) => {
      const u: User = { id: repo.newId(), loginName, passwordHash: "x$y", displayName, role, active: true, createdAt: new Date().toISOString() };
      await repo.insertUser(q, u);
      return u;
    };
    boss = await mk("au-boss", "admin", "林店長");
    sales = await mk("au-sales", "sales", "業務小吳");
    sp = repo.newId();
    await repo.insertSalesperson(q, { id: sp, displayName: "業務小吳", active: true, sortOrder: 1, userAccountId: sales.id });
    itemId = String((await raw`select id from appointment_items order by sort_order limit 1`)[0].id);

    // 產生各種紀錄
    const r = await booking.createSalesAppointment(sales, sp, {
      customerName: "紀錄測試客戶", phone: "0955123456", itemId, partySize: 1, requiresDoctor: false, doctorId: null,
      date: bookableDate(), start: "10:00", preferredDoctorNote: "", careNote: "不要記下這段照護內容",
    }, "au-1", false);
    if (!r.ok) throw new Error(r.message);
    apptId = r.id;
    apptCode = String((await raw`select code from appointments where id = ${apptId}`)[0].code);
    await booking.updateSalesAppointment(sales, sp, apptId, 1, { partySize: 2, careNote: "另一段照護內容" });

    const [doc] = await raw`select id from doctors where display_name = '廖醫師'`;
    await admin.saveShift(boss, true, { doctorId: String(doc.id), weekday: 3, start: "13:00", end: "17:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true });
    await admin.saveBlock(boss, true, { weekday: null, specificDate: bookableDate(10), start: "10:00", end: "12:00", scope: "clinic", doctorId: null, reason: "消防演練" });
    const ref = await repo.loadRef(q);
    await admin.saveSettings(boss, { maxDays: 90, notifyEmails: ref.settings.notifyEmails, notifyModes: { ...ref.settings.notifyModes, sales_edit: "instant" } });
    await admin.addItem(boss, "暫時項目");
    const tmp = (await repo.loadRef(q)).items.find((i) => i.name === "暫時項目")!;
    await admin.deleteItem(boss, tmp.id);
    await admin.createAccount(boss, { displayName: "新業務小許", loginName: "sales-hsu", role: "sales", password: "Password-1234" });
  });

  afterAll(async () => {
    await dbm?.closeSql();
    await raw?.end();
  });

  it("預約紀錄：差異可讀，照護備註只記已修改", async () => {
    const { rows } = await search({ entityType: "appointment" });
    const update = rows.find((r) => r.action === "update")!;
    expect(update.targetLabel).toContain(apptCode);
    expect(update.targetLabel).toContain("紀錄測試客戶");
    expect(update.actorName).toBe("業務小吳");
    const lines = fmt.auditLines(update, await names());
    expect(lines).toContain("人數：1 人 → 2 人");
    expect(lines).toContain("照護備註：已修改（內容請登入後台查看）");
    const all = JSON.stringify(await raw`select changes from audit_logs`);
    expect(all).not.toContain("照護內容");
  });

  it("班表、封鎖、設定、項目、帳號都記下看得懂的內容", async () => {
    const lines = async (type: import("@/lib/audit-format").EntityType, action: string) => {
      const { rows } = await search({ action: `${type}:${action}` });
      expect(rows, `${type}:${action}`).toHaveLength(1);
      return fmt.auditLines(rows[0], await names());
    };
    expect(await lines("schedule", "shift-create")).toEqual(["內容：廖醫師 週三 13:00–17:00（2026-01-01 起）"]);
    expect((await lines("schedule", "block-create"))[0]).toMatch(/^內容：全院封鎖 \d{4}-\d{2}-\d{2} 10:00–12:00：消防演練$/);
    expect(await lines("settings", "update")).toEqual(["最遠可約天數：60 天 → 90 天", "通知方式（一般修改）：日報 → 即時信"]);
    expect(await lines("item", "delete")).toEqual(["名稱：暫時項目"]);
    expect(await lines("account", "create")).toEqual(["名稱：新業務小許", "登入帳號：sales-hsu", "角色：業務"]);
    expect(JSON.stringify(await raw`select changes from audit_logs`)).not.toContain("Password-1234");
  });

  it("篩選：對象、操作者、動作、關鍵字", async () => {
    expect((await search({ entityType: "schedule" })).total).toBe(2);
    expect((await search({ actorUserId: sales.id })).rows.every((r) => r.actorName === "業務小吳")).toBe(true);
    expect((await search({ actorUserId: "not-a-uuid" })).total).toBe(0);
    expect((await search({ action: "item:create" })).total).toBe(1);
    expect((await search({ action: "bogus" })).total).toBe(0);
    expect((await search({ keyword: apptCode })).rows.every((r) => r.entityId === apptId)).toBe(true);
    expect((await search({ keyword: "紀錄測試" })).total).toBeGreaterThanOrEqual(2);
    expect((await search({ keyword: "消防" })).total).toBe(1); // 原因與內容
    expect((await search({ keyword: "廖醫師" })).rows.some((r) => r.action === "shift-create")).toBe(true);
    expect((await search({ keyword: "小許" })).rows.map((r) => r.action)).toContain("create");
  });

  it("關鍵字中的 % 與 _ 當一般字元，不是萬用字元", async () => {
    expect((await search({ keyword: "%" })).total).toBe(0);
    expect((await search({ keyword: "紀%測試" })).total).toBe(0); // 若 % 是萬用字元會配對到「紀錄測試客戶」
    expect((await search({ keyword: "紀_測試" })).total).toBe(0);
    expect((await search({ keyword: "sales_edit" })).rows.map((r) => r.entityType)).toEqual(["settings"]); // 字面上的 _ 照樣找得到
  });

  it("日期以台北時間切日（UTC 16:30 屬於台北隔天）", async () => {
    const [{ id }] = await raw`
      insert into audit_logs (entity_type, entity_id, actor_user_id, action, changes, created_at)
      values ('settings', 'settings', ${boss.id}, 'update', '{}', '2025-03-01T16:30:00Z') returning id`;
    const ids = async (from: string, to: string) => (await search({ from, to })).rows.map((r) => r.id);
    expect(await ids("2025-03-02", "2025-03-02")).toEqual([String(id)]);
    expect(await ids("2025-03-01", "2025-03-01")).toEqual([]);
    expect(await ids("2025-02-01", "2025-03-01")).toEqual([]);
  });

  it("分頁：依時間新到舊，總數正確", async () => {
    const all = await search({});
    const p1 = await search({}, 3, 0);
    const p2 = await search({}, 3, 3);
    expect(p1.total).toBe(all.total);
    expect(p1.rows.map((r) => r.id)).toEqual(all.rows.slice(0, 3).map((r) => r.id));
    expect(p2.rows.map((r) => r.id)).toEqual(all.rows.slice(3, 6).map((r) => r.id));
    const times = all.rows.map((r) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
