/**
 * 資料庫整合測試：同時段鎖位、冪等、版本衝突、預約編號、班表重算、登入鎖定。
 * 需要一個「可以清空」的 PostgreSQL：TEST_DATABASE_URL=postgres://… npm test
 * 未設定 TEST_DATABASE_URL 時整組略過（npm test 仍可只跑規則單元測試）。
 */
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, TEST_URL as url } from "./helpers";

// 必須在 import 服務層之前設定，讓 lib/data/db.ts 連到測試資料庫
if (url) process.env.DATABASE_URL = url;

type Booking = typeof import("@/lib/booking");
type Admin = typeof import("@/lib/admin");
type Repo = typeof import("@/lib/data/repo");
type DbMod = typeof import("@/lib/data/db");
type User = import("@/lib/data/types").UserAccount;

describe.skipIf(!url)("資料庫整合（TEST_DATABASE_URL）", () => {
  let booking: Booking, admin: Admin, repo: Repo, dbm: DbMod;
  let raw: postgres.Sql;
  let salesA: User, salesB: User, boss: User;
  let spA: string, spB: string;
  let itemId: string;

  /** 3 天後、週一到週六的日期（避開週日公休） */
  function bookableDate(offset = 3): string {
    const d = new Date(Date.now() + 8 * 3_600_000); // 台北日期
    d.setUTCDate(d.getUTCDate() + offset);
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  const input = (over: Partial<import("@/lib/booking").BookingInput> = {}) => ({
    customerName: "整合測試客戶", phone: "0912345678", itemId, partySize: 1, requiresDoctor: false, doctorId: null,
    date: bookableDate(), start: "11:00", preferredDoctorNote: "", careNote: "", ...over,
  });

  beforeAll(async () => {
    raw = await resetTestDatabase();
    [booking, admin, repo, dbm] = await Promise.all([import("@/lib/booking"), import("@/lib/admin"), import("@/lib/data/repo"), import("@/lib/data/db")]);

    const q = dbm.sql();
    const mk = async (loginName: string, role: User["role"]) => {
      const u: User = { id: repo.newId(), loginName, passwordHash: "x$y", displayName: loginName, role, active: true, createdAt: new Date().toISOString() };
      await repo.insertUser(q, u);
      return u;
    };
    boss = await mk("it-admin", "admin");
    salesA = await mk("it-sales-a", "sales");
    salesB = await mk("it-sales-b", "sales");
    spA = repo.newId();
    spB = repo.newId();
    await repo.insertSalesperson(q, { id: spA, displayName: "業務 A", active: true, sortOrder: 1, userAccountId: salesA.id });
    await repo.insertSalesperson(q, { id: spB, displayName: "業務 B", active: true, sortOrder: 2, userAccountId: salesB.id });
    const [item] = await raw`select id from appointment_items order by sort_order limit 1`;
    itemId = String(item.id);
  });

  beforeEach(async () => {
    await raw`truncate idempotency_keys, notifications, audit_logs, appointments, schedule_blocks, login_failures`;
  });

  afterAll(async () => {
    await dbm?.closeSql();
    await raw?.end();
  });

  const count = async () => Number((await raw`select count(*)::int as n from appointments`)[0].n);

  it("同一時段 10 個業務同時送出：只有 1 筆成功，其餘看到已額滿", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        booking.createSalesAppointment(i % 2 ? salesB : salesA, i % 2 ? spB : spA, input({ phone: `09123450${String(i).padStart(2, "0")}` }), `race-${i}`, false),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r as { code: string }).code)).toEqual(Array(9).fill("FULL"));
    expect(await count()).toBe(1);
  });

  it("同一請求重送 5 次（同時）：只建立 1 筆，全部回傳同一個 id", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => booking.createSalesAppointment(salesA, spA, input(), "same-key", false)));
    const ids = new Set(results.map((r) => (r.ok ? r.id : "fail")));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe("fail");
    expect(await count()).toBe(1);
  });

  it("同一天不同時段同時建立：預約編號不重複", async () => {
    const hours = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    const results = await Promise.all(hours.map((h, i) => booking.createSalesAppointment(salesA, spA, input({ start: h, phone: `091234560${i}` }), `code-${h}`, false)));
    expect(results.every((r) => r.ok)).toBe(true);
    const codes = (await raw`select code from appointments`).map((r) => r.code);
    expect(new Set(codes).size).toBe(hours.length);
  });

  it("兩人同時改同一筆（同一版本號）：只有一人成功，另一人收到版本衝突", async () => {
    const r = await booking.createSalesAppointment(salesA, spA, input(), "v-1", false);
    if (!r.ok) throw new Error(r.message);
    const results = await Promise.all([
      booking.updateSalesAppointment(salesA, spA, r.id, 1, { customerName: "改名一" }),
      booking.adminUpdateBasics(boss, r.id, 1, { customerName: "改名二", phone: "0912345678", partySize: 2, itemId, careNote: "", preferredDoctorNote: "" }),
      booking.updateSalesAppointment(salesA, spA, r.id, 1, { partySize: 3 }),
    ]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok).every((x) => (x as { code: string }).code === "VERSION")).toBe(true);
    const [row] = await raw`select version from appointments where id = ${r.id}`;
    expect(row.version).toBe(2);
  });

  it("兩筆預約同時改期到同一個空時段：只有一筆成功", async () => {
    const a = await booking.createSalesAppointment(salesA, spA, input({ start: "10:00" }), "mv-a", false);
    const b = await booking.createSalesAppointment(salesB, spB, input({ start: "12:00", phone: "0922333444" }), "mv-b", false);
    if (!a.ok || !b.ok) throw new Error("setup");
    const date = bookableDate();
    const results = await Promise.all([
      booking.updateSalesAppointment(salesA, spA, a.id, 1, { time: { date, start: "15:00" } }),
      booking.updateSalesAppointment(salesB, spB, b.id, 1, { time: { date, start: "15:00" } }),
    ]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const [n] = await raw`select count(*)::int as n from appointments where start_time = '15:00' and status = 'active'`;
    expect(n.n).toBe(1);
  });

  it("業務查不到別人的預約；不合法的 id 也只回 null", async () => {
    const r = await booking.createSalesAppointment(salesA, spA, input(), "own-1", false);
    if (!r.ok) throw new Error(r.message);
    expect(await booking.getOwnAppointment(spA, r.id)).not.toBeNull();
    expect(await booking.getOwnAppointment(spB, r.id)).toBeNull();
    expect(await booking.getOwnAppointment(spA, "not-a-uuid'; drop table appointments;--")).toBeNull();
    const res = await booking.updateSalesAppointment(salesB, spB, r.id, 1, { customerName: "偷改" });
    expect(res.ok).toBe(false);
  });

  it("重複電話未確認：不寫入任何資料；確認後建立並產生通知", async () => {
    await booking.createSalesAppointment(salesA, spA, input({ start: "10:00" }), "dup-1", false);
    const second = await booking.createSalesAppointment(salesB, spB, input({ start: "14:00", phone: "+886 912-345-678" }), "dup-2", false);
    expect(second.ok).toBe(false);
    expect((second as { code: string }).code).toBe("DUPLICATE_PHONE");
    expect(await count()).toBe(1);
    const third = await booking.createSalesAppointment(salesB, spB, input({ start: "14:00", phone: "+886 912-345-678" }), "dup-2", true);
    expect(third.ok).toBe(true);
    const [n] = await raw`select count(*)::int as n from notifications where event_type = 'duplicate_phone'`;
    expect(n.n).toBe(1);
  });

  it("全院封鎖：先預覽不寫入，儲存後受影響預約標為衝突；移除封鎖後恢復", async () => {
    const r = await booking.createSalesAppointment(salesA, spA, input({ start: "13:00" }), "blk-1", false);
    if (!r.ok) throw new Error(r.message);
    const block = { weekday: null, specificDate: bookableDate(), start: "12:00", end: "15:00", scope: "clinic" as const, doctorId: null, reason: "整合測試" };

    const preview = await admin.saveBlock(boss, false, block);
    expect(preview).toMatchObject({ ok: true, phase: "preview" });
    expect((preview as { affected: unknown[] }).affected).toHaveLength(1);
    expect(Number((await raw`select count(*)::int as n from schedule_blocks`)[0].n)).toBe(0);

    const saved = await admin.saveBlock(boss, true, block);
    expect(saved).toMatchObject({ ok: true, phase: "saved", changed: 1 });
    const [row] = await raw`select conflict_status, conflict_reasons from appointments where id = ${r.id}`;
    expect(row.conflict_status).toBe("conflict");
    expect(row.conflict_reasons).toEqual(["BLOCKED"]);

    // 封鎖中的時段不能再約
    const blocked = await booking.createSalesAppointment(salesB, spB, input({ start: "14:00", phone: "0933444555" }), "blk-2", false);
    expect((blocked as { code: string }).code).toBe("BLOCKED");

    const [b] = await raw`select id from schedule_blocks`;
    await admin.removeBlock(boss, String(b.id));
    const [after] = await raw`select conflict_status from appointments where id = ${r.id}`;
    expect(after.conflict_status).toBe("none");
  });

  it("班表異動與預約同時進行：不會漏算衝突", async () => {
    const block = { weekday: null, specificDate: bookableDate(), start: "10:00", end: "19:00", scope: "clinic" as const, doctorId: null, reason: "並行測試" };
    const results = await Promise.all([
      ...["10:00", "11:00", "12:00", "13:00"].map((h, i) => booking.createSalesAppointment(salesA, spA, input({ start: h, phone: `094444444${i}` }), `par-${h}`, false)),
      admin.saveBlock(boss, true, block),
    ]);
    // 不論誰先：建立成功的預約一定都被標為衝突（封鎖先儲存則建立會失敗）
    const created = results.slice(0, 4).filter((r) => r.ok).length;
    const [n] = await raw`select count(*)::int as n from appointments where conflict_status = 'conflict'`;
    expect(n.n).toBe(created);
  });

  it("停用最後一位店長被擋下；有未來預約的業務需先轉出才能停用", async () => {
    expect(await admin.setAccountActive(boss, boss.id, false)).toMatchObject({ ok: false });
    await booking.createSalesAppointment(salesB, spB, input(), "xfer-1", false);
    const blocked = await admin.setAccountActive(boss, salesB.id, false);
    expect(blocked).toMatchObject({ ok: false, mustTransfer: { salespersonId: spB, count: 1 } });
    expect(await admin.transferFutureAppointments(boss, spB, spA)).toEqual({ ok: true, count: 1 });
    expect(await admin.setAccountActive(boss, salesB.id, false)).toEqual({ ok: true });
    expect(await admin.setAccountActive(boss, salesB.id, true)).toEqual({ ok: true });
  });

  it("登入失敗 5 次（含同時嘗試）後鎖定，不會少算", async () => {
    const q = dbm.sql();
    await Promise.all(Array.from({ length: 4 }, () => repo.recordLoginFailure(q, "someone", 5, 10)));
    expect(await repo.loginLockedUntil(q, "someone")).toBe(0);
    await repo.recordLoginFailure(q, "someone", 5, 10);
    expect(await repo.loginLockedUntil(q, "someone")).toBeGreaterThan(Date.now());
    await repo.clearLoginFailure(q, "someone");
    expect(await repo.loginLockedUntil(q, "someone")).toBe(0);
  });

  it("session：只存雜湊、過期失效、可整批撤銷", async () => {
    const q = dbm.sql();
    await repo.insertSession(q, "hash-1", salesA.id, new Date(Date.now() + 60_000));
    await repo.insertSession(q, "hash-2", salesA.id, new Date(Date.now() - 1_000));
    expect(await repo.findSessionUser(q, "hash-1")).toBe(salesA.id);
    expect(await repo.findSessionUser(q, "hash-2")).toBeNull();
    await repo.deleteUserSessions(q, salesA.id);
    expect(await repo.findSessionUser(q, "hash-1")).toBeNull();
  });
});
