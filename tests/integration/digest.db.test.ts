/**
 * 每日 21:00 日報：時間判斷、彙整範圍、每天只一封、沒事件不寄、重試、並行、排程端點驗證。
 */
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, TEST_URL as url } from "./helpers";

if (url) process.env.DATABASE_URL = url;

type User = import("@/lib/data/types").UserAccount;
type Mail = import("@/lib/notify/transport").OutgoingEmail;
type SendResult = import("@/lib/notify/transport").SendResult;

describe.skipIf(!url)("每日日報（TEST_DATABASE_URL）", () => {
  let booking: typeof import("@/lib/booking");
  let deliver: typeof import("@/lib/notify/deliver");
  let transport: typeof import("@/lib/notify/transport");
  let repo: typeof import("@/lib/data/repo");
  let dbm: typeof import("@/lib/data/db");
  let route: typeof import("@/app/api/cron/daily/route");
  let raw: postgres.Sql;
  let sales: User;
  let sp: string, itemId: string;
  let sent: Mail[] = [];
  let respond: (m: Mail) => Promise<SendResult> = async () => ({ ok: true, messageId: "m" });

  const taipeiToday = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  /** 台北今天某時刻 */
  const at = (hhmm: string, date = taipeiToday()) => new Date(`${date}T${hhmm}:00+08:00`);
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  function bookableDate(offset = 3): string {
    const d = new Date(Date.now() + 8 * 3_600_000);
    d.setUTCDate(d.getUTCDate() + offset);
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /** 建一筆預約並做 n 次一般修改（一般修改預設為「日報」） */
  async function edits(key: string, start: string, n: number) {
    const r = await booking.createSalesAppointment(sales, sp, {
      customerName: `日報客戶${key}`, phone: `0933${String(++phoneSeq).padStart(6, "0")}`, itemIds: [itemId], partySize: 1,
      requiresDoctor: false, doctorId: null, date: bookableDate(), start, preferredDoctorNote: "", careNote: "",
    }, key, true);
    if (!r.ok) throw new Error(r.message);
    for (let v = 1; v <= n; v++) {
      const e = await booking.updateSalesAppointment(sales, sp, r.id, v, { partySize: v + 1 });
      if (!e.ok) throw new Error(e.message);
    }
    return r.id;
  }
  let phoneSeq = 0; // 每筆不同電話，避免觸發重複電話的即時信

  beforeAll(async () => {
    raw = await resetTestDatabase();
    [booking, deliver, transport, repo, dbm, route] = await Promise.all([
      import("@/lib/booking"), import("@/lib/notify/deliver"), import("@/lib/notify/transport"), import("@/lib/data/repo"),
      import("@/lib/data/db"), import("@/app/api/cron/daily/route"),
    ]);
    transport.setMailTransportForTests({ name: "fake", send: async (m) => { sent.push(m); return respond(m); } });
    sales = { id: repo.newId(), loginName: "dg-sales", passwordHash: "x$y", displayName: "業務小周", role: "sales", active: true, createdAt: new Date().toISOString() };
    await repo.insertUser(dbm.sql(), sales);
    sp = repo.newId();
    await repo.insertSalesperson(dbm.sql(), { id: sp, displayName: "業務小周", active: true, sortOrder: 1, userAccountId: sales.id });
    itemId = String((await raw`select id from appointment_items order by sort_order limit 1`)[0].id);
  });

  beforeEach(async () => {
    await raw`truncate idempotency_keys, notifications, email_digests, audit_logs, appointments`;
    await raw`update system_settings set value = '["boss@example.com"]' where key = 'notify_emails'`;
    sent = [];
    respond = async () => ({ ok: true, messageId: "m" });
  });

  afterAll(async () => {
    transport?.setMailTransportForTests(null);
    await dbm?.closeSql();
    await raw?.end();
  });

  const digestCount = async () => Number((await raw`select count(*)::int as n from email_digests`)[0].n);

  it("台北 21:00 以前不建立日報", async () => {
    await edits("a", "10:00", 1);
    expect(await deliver.runDailyDigest(at("20:59"))).toEqual({ status: "too_early", date: taipeiToday() });
    expect(await digestCount()).toBe(0);
  });

  it("沒有日報事件：不建立、不寄", async () => {
    expect(await deliver.runDailyDigest(at("21:00"))).toEqual({ status: "no_events", date: taipeiToday() });
    await deliver.deliverAll();
    expect(sent).toHaveLength(0);
    expect(await digestCount()).toBe(0);
  });

  it("彙整所有尚未寄過的日報事件成一封；即時信不在其中；同一天再跑不會重寄", async () => {
    await edits("b", "10:00", 2);
    await edits("c", "12:00", 1);
    const id = await edits("d", "14:00", 0);
    await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true }); // 取消 → 即時信

    const run = await deliver.runDailyDigest(at("21:03"));
    expect(run).toEqual({ status: "created", date: taipeiToday(), events: 3 });
    const report = await deliver.deliverAll();
    expect(report).toEqual({ instant: { sent: 1, failed: 0, stopped: 0 }, digest: { sent: 1, failed: 0, stopped: 0 } });

    const digest = sent.find((m) => m.subject.includes("每日日報"))!;
    expect(digest.subject).toBe(`[PURE IN 預約] 每日日報｜${taipeiToday()}（3 件）`);
    expect(digest.idempotencyKey).toBe(`digest-${taipeiToday()}`);
    expect(digest.to).toEqual(["boss@example.com"]);
    expect(digest.text).toContain("人數：1 人 → 2 人");
    expect(digest.text).toContain("人數：2 人 → 3 人");
    expect(digest.text).not.toContain("取消預約");

    expect(await deliver.runDailyDigest(at("21:30"))).toEqual({ status: "already_created", date: taipeiToday(), events: 3 });
    await deliver.deliverAll();
    expect(sent.filter((m) => m.subject.includes("每日日報"))).toHaveLength(1);
  });

  it("當天日報建立之後的事件，進下一天的日報", async () => {
    await edits("e", "10:00", 1);
    await deliver.runDailyDigest(at("21:00"));
    await edits("f", "12:00", 2);
    const tomorrow = nextDay(taipeiToday());
    expect(await deliver.runDailyDigest(at("21:00", tomorrow))).toEqual({ status: "created", date: tomorrow, events: 2 });
    const [{ n }] = await raw`select count(*)::int as n from notifications where email_mode = 'digest' and digest_id is null`;
    expect(n).toBe(0);
  });

  it("寄送失敗會重試，用同一個冪等鍵；沒有收件地址則停止並可重新寄送", async () => {
    await edits("g", "10:00", 1);
    await deliver.runDailyDigest(at("21:00"));
    respond = async () => ({ ok: false, error: "Resend 502", permanent: false });
    expect((await deliver.deliverAll()).digest).toEqual({ sent: 0, failed: 1, stopped: 0 });
    const [d] = await raw`select id, email_error, email_next_attempt_at from email_digests`;
    expect(d.email_error).toBe("Resend 502");
    expect(d.email_next_attempt_at).not.toBeNull();

    await raw`update email_digests set email_next_attempt_at = now()`;
    await raw`update system_settings set value = '[]' where key = 'notify_emails'`;
    expect((await deliver.deliverAll()).digest).toEqual({ sent: 0, failed: 0, stopped: 1 });
    expect((await raw`select email_error from email_digests`)[0].email_error).toContain("未設定通知收件地址");

    await raw`update system_settings set value = '["boss@example.com"]' where key = 'notify_emails'`;
    respond = async () => ({ ok: true, messageId: "ok" });
    expect(await repo.requeueDigest(dbm.sql(), String(d.id))).toBe(true);
    expect((await deliver.deliverAll()).digest).toEqual({ sent: 1, failed: 0, stopped: 0 });
    expect(new Set(sent.map((m) => m.idempotencyKey))).toEqual(new Set([`digest-${taipeiToday()}`]));
  });

  it("排程重複觸發（同時 3 次）：只建立一封，事件不重複", async () => {
    await edits("h", "10:00", 2);
    const runs = await Promise.all([1, 2, 3].map(() => deliver.runDailyDigest(at("21:01"))));
    expect(runs.filter((r) => r.status === "created")).toHaveLength(1);
    expect(runs.filter((r) => r.status === "already_created")).toHaveLength(2);
    await Promise.all([deliver.deliverAll(), deliver.deliverAll()]);
    expect(sent.filter((m) => m.subject.includes("每日日報"))).toHaveLength(1);
  });

  describe("排程端點 /api/cron/daily", () => {
    const call = (auth?: string) => route.GET(new Request("http://localhost/api/cron/daily", { headers: auth ? { authorization: auth } : {} }));
    afterAll(() => { delete process.env.CRON_SECRET; });

    it("未設定 CRON_SECRET：拒絕（503）", async () => {
      delete process.env.CRON_SECRET;
      expect((await call("Bearer anything")).status).toBe(503);
    });

    it("金鑰錯誤或沒帶：401，不做任何事", async () => {
      process.env.CRON_SECRET = "s3cret-value";
      await edits("i", "10:00", 1);
      expect((await call()).status).toBe(401);
      expect((await call("Bearer wrong")).status).toBe(401);
      expect((await call("s3cret-value")).status).toBe(401);
      expect(await digestCount()).toBe(0);
    });

    it("金鑰正確：執行日報與補寄，回傳結果", async () => {
      process.env.CRON_SECRET = "s3cret-value";
      const res = await call("Bearer s3cret-value");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.digest.date).toBe(taipeiToday());
      expect(["too_early", "no_events", "created"]).toContain(body.digest.status); // 依實際執行時刻
      expect(body.delivery).toHaveProperty("instant");
      expect(body.delivery).toHaveProperty("digest");
    });
  });
});
