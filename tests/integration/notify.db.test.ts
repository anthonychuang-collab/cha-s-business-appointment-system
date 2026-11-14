/**
 * 即時信寄送（outbox）：寄信失敗不影響預約、重試、停止條件、不重複寄送、Resend API 呼叫格式。
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, TEST_URL as url } from "./helpers";

if (url) process.env.DATABASE_URL = url;

type User = import("@/lib/data/types").UserAccount;
type Mail = import("@/lib/notify/transport").OutgoingEmail;
type SendResult = import("@/lib/notify/transport").SendResult;

describe.skipIf(!url)("即時信寄送（TEST_DATABASE_URL）", () => {
  let booking: typeof import("@/lib/booking");
  let deliver: typeof import("@/lib/notify/deliver");
  let transport: typeof import("@/lib/notify/transport");
  let repo: typeof import("@/lib/data/repo");
  let dbm: typeof import("@/lib/data/db");
  let raw: postgres.Sql;
  let sales: User, deputy: User;
  let sp: string, itemId: string;

  /** 假的寄信方式：記錄每封信，回應可由測試控制 */
  let sent: Mail[] = [];
  let respond: (m: Mail) => Promise<SendResult> = async () => ({ ok: true, messageId: "msg" });

  function bookableDate(offset = 3): string {
    const d = new Date(Date.now() + 8 * 3_600_000);
    d.setUTCDate(d.getUTCDate() + offset);
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const input = (over: Partial<import("@/lib/booking").BookingInput> = {}) => ({
    customerName: "通知測試客戶", phone: "0912000111", itemIds: [itemId], partySize: 1, requiresDoctor: false, doctorId: null,
    date: bookableDate(), start: "11:00", preferredDoctorNote: "", careNote: "糖尿病，需低糖點心", ...over,
  });

  async function book(key: string, over = {}) {
    const r = await booking.createSalesAppointment(sales, sp, input(over), key, true);
    if (!r.ok) throw new Error(r.message);
    return r.id;
  }
  const setEmails = (emails: string[]) => raw`update system_settings set value = ${raw.json(emails)} where key = 'notify_emails'`;
  const rows = () => raw`select event_type, email_mode, email_sent_at, email_error, email_attempts, email_next_attempt_at, email_message_id, payload from notifications order by created_at`;
  /** 模擬時間經過：讓排定的重試立即到期 */
  const fastForward = () => raw`update notifications set email_next_attempt_at = now() where email_next_attempt_at is not null`;

  beforeAll(async () => {
    raw = await resetTestDatabase();
    [booking, deliver, transport, repo, dbm] = await Promise.all([
      import("@/lib/booking"), import("@/lib/notify/deliver"), import("@/lib/notify/transport"), import("@/lib/data/repo"), import("@/lib/data/db"),
    ]);
    transport.setMailTransportForTests({ name: "fake", send: async (m) => { sent.push(m); return respond(m); } });
    const q = dbm.sql();
    const mk = async (loginName: string, role: User["role"], displayName: string) => {
      const u: User = { id: repo.newId(), loginName, passwordHash: "x$y", displayName, role, active: true, createdAt: new Date().toISOString() };
      await repo.insertUser(q, u);
      return u;
    };
    sales = await mk("n-sales", "sales", "業務小陳");
    deputy = await mk("n-deputy", "deputy", "代理小林");
    sp = repo.newId();
    await repo.insertSalesperson(q, { id: sp, displayName: "業務小陳", active: true, sortOrder: 1, userAccountId: sales.id });
    itemId = String((await raw`select id from appointment_items order by sort_order limit 1`)[0].id);
  });

  beforeEach(async () => {
    await raw`truncate idempotency_keys, notifications, audit_logs, appointments`;
    await setEmails(["boss@example.com", "owner@example.com"]);
    sent = [];
    respond = async () => ({ ok: true, messageId: "msg" });
    delete process.env.APP_BASE_URL;
  });

  afterAll(async () => {
    transport?.setMailTransportForTests(null);
    await dbm?.closeSql();
    await raw?.end();
  });

  it("業務取消：寄出即時信給所有收件地址，含差異與後台連結，不含照護備註原文", async () => {
    process.env.APP_BASE_URL = "https://booking.example.com";
    const id = await book("c-1");
    const r = await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    expect(r.ok).toBe(true);
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 1, failed: 0, stopped: 0 });

    expect(sent).toHaveLength(1);
    const [m] = sent;
    expect(m.to).toEqual(["boss@example.com", "owner@example.com"]);
    expect(m.subject).toMatch(/^\[PURE IN 預約\] 業務取消預約｜\d{4}-\d{2}-\d{2} 11:00 PI-/);
    expect(m.text).toContain("操作者：業務小陳");
    expect(m.text).toContain("狀態：已預約 → 已取消");
    expect(m.text).toContain(`https://booking.example.com/admin/appointments/${id}`);
    expect(m.text + m.html).not.toContain("糖尿病");
    expect(m.idempotencyKey).toMatch(/^notification-/);

    const [n] = (await rows()).filter((x) => x.event_type === "sales_cancel");
    expect(n.email_sent_at).not.toBeNull();
    expect(n.email_next_attempt_at).toBeNull();
    expect(n.email_message_id).toBe("msg");
    // 再跑一次不會重寄
    await deliver.deliverPendingEmails();
    expect(sent).toHaveLength(1);
  });

  it("日報與不寄信的事件不會即時寄出，但都寫進通知清單", async () => {
    const id = await book("d-1");
    await raw`update system_settings set value = jsonb_set(value, '{sales_cancel}', '"none"') where key = 'notify_modes'`;
    await booking.updateSalesAppointment(sales, sp, id, 1, { partySize: 2 }); // 一般修改 → 日報
    await booking.updateSalesAppointment(sales, sp, id, 2, { cancel: true }); // 取消改成不寄
    await raw`update system_settings set value = jsonb_set(value, '{sales_cancel}', '"instant"') where key = 'notify_modes'`;
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 0, failed: 0, stopped: 0 });
    expect(sent).toHaveLength(0);
    expect((await rows()).map((n) => n.email_mode)).toEqual(["digest", "none"]);
  });

  it("寄信失敗不影響預約；依間隔重試，成功後停止，重試用同一個冪等鍵", async () => {
    respond = async () => ({ ok: false, error: "Resend 503", permanent: false });
    const id = await book("f-1");
    const r = await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    expect(r.ok).toBe(true);
    expect((await raw`select status from appointments where id = ${id}`)[0].status).toBe("cancelled");

    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 0, failed: 1, stopped: 0 });
    let [n] = await rows();
    expect(n.email_error).toBe("Resend 503");
    expect(n.email_attempts).toBe(1);
    const wait = (n.email_next_attempt_at as Date).getTime() - Date.now();
    expect(wait).toBeGreaterThan(50_000); // 第一次失敗後約 1 分鐘再試
    expect(wait).toBeLessThan(70_000);

    // 時間未到不會重試
    await deliver.deliverPendingEmails();
    expect(sent).toHaveLength(1);

    await fastForward();
    respond = async () => ({ ok: true, messageId: "msg-2" });
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 1, failed: 0, stopped: 0 });
    [n] = await rows();
    expect(n.email_sent_at).not.toBeNull();
    expect(n.email_error).toBeNull();
    expect(n.email_attempts).toBe(2);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(1);
  });

  it("寄信程式丟出例外也只記錄為失敗", async () => {
    respond = async () => { throw new Error("socket hang up"); };
    const id = await book("t-1");
    await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 0, failed: 1, stopped: 0 });
    expect((await rows())[0].email_error).toBe("socket hang up");
  });

  it("持續失敗：第 6 次後停止重試", async () => {
    respond = async () => ({ ok: false, error: "Resend 500", permanent: false });
    const id = await book("m-1");
    await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    for (let i = 1; i <= 6; i++) {
      await deliver.deliverPendingEmails();
      await fastForward();
    }
    const [n] = await rows();
    expect(n.email_attempts).toBe(6);
    expect(n.email_next_attempt_at).toBeNull();
    expect(n.email_error).toContain("停止重試");
    await deliver.deliverPendingEmails();
    expect(sent).toHaveLength(6);
  });

  it("設定錯誤（永久失敗）立即停止；店長修好後可重新寄送", async () => {
    respond = async () => ({ ok: false, error: "Resend 403：domain is not verified", permanent: true });
    const id = await book("p-1");
    await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 0, failed: 0, stopped: 1 });
    let [n] = (await raw`select id, email_next_attempt_at, email_error from notifications`);
    expect(n.email_next_attempt_at).toBeNull();
    expect(n.email_error).toContain("not verified");

    respond = async () => ({ ok: true, messageId: "fixed" });
    expect(await repo.requeueEmail(dbm.sql(), String(n.id))).toBe(true);
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 1, failed: 0, stopped: 0 });
    [n] = await raw`select email_sent_at, email_error from notifications`;
    expect(n.email_sent_at).not.toBeNull();
    // 已寄出的不能再排
    expect(await repo.requeueEmail(dbm.sql(), String((await raw`select id from notifications`)[0].id))).toBe(false);
  });

  it("沒有收件地址：不寄、標示原因", async () => {
    await setEmails([]);
    const id = await book("e-1");
    await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    expect(await deliver.deliverPendingEmails()).toEqual({ sent: 0, failed: 0, stopped: 1 });
    expect((await rows())[0].email_error).toContain("未設定通知收件地址");
    expect(sent).toHaveLength(0);
  });

  it("多個程序同時寄送：每封信只寄一次", async () => {
    respond = async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true, messageId: "m" }; };
    const hours = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    for (const [i, h] of hours.entries()) {
      const id = await book(`cc-${i}`, { start: h, phone: `09120002${String(i).padStart(2, "0")}` });
      await booking.updateSalesAppointment(sales, sp, id, 1, { cancel: true });
    }
    const reports = await Promise.all([1, 2, 3, 4].map(() => deliver.deliverPendingEmails()));
    expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(hours.length);
    expect(sent).toHaveLength(hours.length);
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(hours.length);
  });

  it("重複電話：通知內容附上同電話的其他預約", async () => {
    await book("r-1", { start: "10:00", customerName: "第一筆" });
    await book("r-2", { start: "15:00", customerName: "第二筆", phone: "+886 912-000-111" });
    await deliver.deliverPendingEmails();
    const m = sent.find((x) => x.subject.includes("重複電話"))!;
    expect(m.text).toContain("【同一電話的其他預約】");
    expect(m.text).toMatch(/PI-\d{8}-001　\S+ 10:00　第一筆/);
  });

  it("代理店長操作：店長收到即時信並看到修改前後", async () => {
    const id = await book("dp-1");
    const r = await booking.adminUpdateBasics(deputy, id, 1, { customerName: "改過的名字", phone: "0912000111", partySize: 3, itemIds: [itemId], careNote: "新的照護內容", preferredDoctorNote: "" });
    expect(r.ok).toBe(true);
    await deliver.deliverPendingEmails();
    const m = sent.find((x) => x.subject.includes("代理店長操作"))!;
    expect(m.text).toContain("操作者：代理小林");
    expect(m.text).toContain("姓名：通知測試客戶 → 改過的名字");
    expect(m.text).toContain("人數：1 人 → 3 人");
    expect(m.text).toContain("照護備註：已修改");
    expect(m.text + m.html).not.toContain("新的照護內容");
  });

  describe("Resend API", () => {
    let server: Server;
    let base = "";
    let reply: { status: number; body: unknown } = { status: 200, body: { id: "re_123" } };
    const calls: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          calls.push({ headers: req.headers, body: JSON.parse(data || "{}") });
          res.writeHead(reply.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(reply.body));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const mail: Mail = { to: ["a@example.com"], subject: "主旨", text: "內文", html: "<p>內文</p>", idempotencyKey: "notification-1" };

    it("帶金鑰與冪等鍵呼叫 /emails，回傳信件 id", async () => {
      reply = { status: 200, body: { id: "re_123" } };
      const t = transport.resendTransport("re_test_key", "PURE IN <noreply@example.com>", base);
      expect(await t.send(mail)).toEqual({ ok: true, messageId: "re_123" });
      const c = calls.at(-1)!;
      expect(c.headers.authorization).toBe("Bearer re_test_key");
      expect(c.headers["idempotency-key"]).toBe("notification-1");
      expect(c.body).toEqual({ from: "PURE IN <noreply@example.com>", to: ["a@example.com"], subject: "主旨", text: "內文", html: "<p>內文</p>" });
    });

    it("429／5xx 稍後重試；其他 4xx 視為設定錯誤", async () => {
      const t = transport.resendTransport("k", "f@example.com", base);
      for (const [status, permanent] of [[429, false], [500, false], [503, false], [409, false], [401, true], [403, true], [422, true]] as const) {
        reply = { status, body: { name: "x", message: `status ${status}` } };
        const r = await t.send(mail);
        expect(r, String(status)).toEqual({ ok: false, error: `Resend ${status}：status ${status}`, permanent });
      }
    });

    it("連不上 Resend：稍後重試", async () => {
      const t = transport.resendTransport("k", "f@example.com", "http://127.0.0.1:1");
      const r = await t.send(mail);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.permanent).toBe(false);
    });
  });
});
