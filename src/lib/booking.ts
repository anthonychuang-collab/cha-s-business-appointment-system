import "server-only";
/**
 * 預約服務層：所有預約讀寫都經過這裡，規則一律交給 lib/domain（有單元測試）。
 *
 * 【並行安全】每個標註「TRANSACTION」的函式都在同一個資料庫交易內完成：
 *   1. 先取班表共用鎖（班表異動時取獨占鎖，兩者互斥）
 *   2. 修改既有預約先 SELECT … FOR UPDATE 鎖住該列，再比對版本號
 *   3. 讀取時段占用前取 pg_advisory_xact_lock(hashtext(date || start))
 *   4. 產生當日預約編號前取當日編號鎖
 * 鎖都是交易層級（適用 Supabase transaction pooler），交易結束自動釋放。
 */
import { cache } from "react";
import { sql, withTx, type Q } from "@/lib/data/db";
import * as repo from "@/lib/data/repo";
import type { Ref } from "@/lib/data/repo";
import type { Appointment, NotifyEvent, Role, UserAccount } from "@/lib/data/types";
import type { ScheduleData } from "@/lib/domain/schedule";
import { computeSlots, type Slot } from "@/lib/domain/slots";
import { checkSalesCreate, checkSalesEdit, type SalesChanges } from "@/lib/domain/rules";
import { checkAdminCreate } from "@/lib/domain/admin-create";
import { evaluateConflict, recomputeConflicts, type ConflictChange } from "@/lib/domain/conflicts";
import { normalizePhone } from "@/lib/domain/phone";
import { addDays, minutesUntil, toTaipei } from "@/lib/domain/time";
import { endOf, RULE_MESSAGE } from "@/lib/format";
import { describeChanges, snapshotOf, type NotificationPayload } from "@/lib/notify/email";
import { scheduleEmailDelivery } from "@/lib/notify/deliver";

export type Fail = { ok: false; code: string; message: string; field?: string };
const fail = (code: string, message = RULE_MESSAGE[code] ?? "操作失敗，請稍後再試。", field?: string): Fail => ({ ok: false, code, message, field });

/** 交易內的工作環境：連線 + 當下的設定類資料 */
interface Ctx {
  q: Q;
  ref: Ref;
  /** 交易內產生了即時信 → 交易提交後寄送 */
  emailQueued: boolean;
}

// ---------- 讀取 ----------

/** 頁面用：同一個請求只讀一次設定類資料（醫師、項目、班表、帳號名稱…） */
export const pageRef = cache((): Promise<Ref> => repo.loadRef(sql()));

export function scheduleData(ref: Ref): ScheduleData {
  return { openings: ref.openings, doctors: ref.doctors, doctorShifts: ref.shifts, blocks: ref.blocks };
}

export function namesOf(ref: Ref) {
  return {
    itemName: (id: string) => ref.items.find((i) => i.id === id)?.name ?? "（已刪除項目）",
    doctorName: (id: string | null) => (id ? ref.doctors.find((d) => d.id === id)?.displayName ?? "—" : "—"),
    salespersonName: (id: string) => ref.salespeople.find((s) => s.id === id)?.displayName ?? "—",
    userName: (id: string) => ref.users.find((u) => u.id === id)?.displayName ?? "系統",
  };
}

/** 頁面用：名稱查詢函式 */
export async function getNames() {
  return namesOf(await pageRef());
}

async function slotsFor(c: Ctx, date: string, requiresDoctor: boolean, excludeId?: string): Promise<Slot[]> {
  const occupied = await repo.occupiedByDate(c.q, date, date, excludeId);
  return computeSlots({
    now: new Date(), maxDays: c.ref.settings.maxDays, date, requiresDoctor,
    occupiedStarts: occupied.get(date) ?? [], schedule: scheduleData(c.ref),
  });
}

export async function salesSlots(date: string, requiresDoctor: boolean, excludeId?: string): Promise<Slot[]> {
  return slotsFor({ q: sql(), ref: await pageRef(), emailQueued: false }, date, requiresDoctor, excludeId);
}

/** 某月每一天是否還有可約時段（日期元件停用用）；整個月只查一次資料庫 */
export async function monthAvailability(year: number, month: number, requiresDoctor: boolean, excludeId?: string): Promise<Record<string, boolean>> {
  const ref = await pageRef();
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const occupied = await repo.occupiedByDate(sql(), `${ym}-01`, `${ym}-${String(days).padStart(2, "0")}`, excludeId);
  const now = new Date();
  const out: Record<string, boolean> = {};
  for (let d = 1; d <= days; d++) {
    const date = `${ym}-${String(d).padStart(2, "0")}`;
    out[date] = computeSlots({
      now, maxDays: ref.settings.maxDays, date, requiresDoctor, occupiedStarts: occupied.get(date) ?? [], schedule: scheduleData(ref),
    }).some((s) => s.available);
  }
  return out;
}

export function todayTaipei(): string {
  return toTaipei(new Date()).date;
}
export async function maxBookableDate(): Promise<string> {
  return addDays(todayTaipei(), (await pageRef()).settings.maxDays);
}

/** 業務只能看負責業務是自己的預約；找不到一律回 null（不透露是否存在） */
export async function getOwnAppointment(salespersonId: string, id: string): Promise<Appointment | null> {
  const a = await repo.findAppointment(sql(), id);
  return a && a.salespersonId === salespersonId ? a : null;
}

export async function listOwnAppointments(salespersonId: string): Promise<Appointment[]> {
  return repo.listAppointments(sql(), { salespersonId, dateFrom: todayTaipei() });
}

// ---------- 通知與稽核 ----------

/**
 * 寫入後台通知（一律寫入，規格 7.3），並附上寄信用的預約摘要與差異。
 * 即時信不在交易內寄送：交易提交後才由 lib/notify/deliver.ts 寄出，寄信失敗不影響預約。
 */
async function notify(
  c: Ctx, event: NotifyEvent, a: Appointment, actor: UserAccount, summary: string,
  extra: { changes?: Record<string, unknown>; related?: Appointment[] } = {},
) {
  const mode = c.ref.settings.notifyModes[event];
  const names = namesOf(c.ref);
  const payload: NotificationPayload = { appointment: snapshotOf(a, names) };
  if (extra.changes) payload.changes = describeChanges(extra.changes, names);
  if (extra.related?.length) payload.related = extra.related.map((r) => snapshotOf(r, names));
  await repo.insertNotification(c.q, { event, appointmentId: a.id, actorUserId: actor.id, summary, mode, payload: { ...payload } });
  if (mode === "instant") c.emailQueued = true;
}

async function audit(c: Ctx, entityId: string, actor: UserAccount, action: string, changes: Record<string, unknown> = {}, reason = "") {
  await repo.insertAudit(c.q, { entityType: "appointment", entityId, actorUserId: actor.id, action, changes, reason });
}

/** 代理店長的每個預約操作都要通知店長（規格 7.4） */
async function notifyIfDeputy(c: Ctx, actor: UserAccount, a: Appointment, what: string, changes?: Record<string, unknown>) {
  if (actor.role === "deputy") await notify(c, "deputy_action", a, actor, `${actor.displayName}${what}：${a.date} ${a.start} ${a.customerName}`, { changes });
}

/** 當日流水號；取當日編號鎖，兩筆同日預約不會拿到同一個編號 */
async function newCode(c: Ctx, date: string): Promise<string> {
  await repo.lockKey(c.q, `code:${date}`);
  const n = (await repo.countAppointmentsOnDate(c.q, date)) + 1;
  return `PI-${date.replaceAll("-", "")}-${String(n).padStart(3, "0")}`;
}

/** 寫回預約；FOR UPDATE 之後理論上不會失敗，失敗就丟錯讓整個交易回滾 */
async function save(c: Ctx, a: Appointment, expectedVersion: number) {
  if (!(await repo.saveAppointment(c.q, a, expectedVersion))) throw new Error(`appointment ${a.id} version changed during transaction`);
}

/** 交易開頭：班表共用鎖 + 讀取設定類資料；交易提交後才排寄信（回滾就不寄） */
async function bookingTx<T>(fn: (c: Ctx) => Promise<T>): Promise<T> {
  let emailQueued = false;
  const result = await withTx(async (q) => {
    await repo.lockSchedule(q, "shared");
    const c: Ctx = { q, ref: await repo.loadRef(q), emailQueued: false };
    const r = await fn(c);
    emailQueued = c.emailQueued;
    return r;
  });
  if (emailQueued) scheduleEmailDelivery();
  return result;
}

// ---------- 輸入驗證 ----------

export interface BookingInput {
  customerName: string;
  phone: string;
  itemId: string;
  partySize: number;
  requiresDoctor: boolean;
  doctorId: string | null;
  date: string;
  start: string;
  preferredDoctorNote: string;
  careNote: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateBasics(i: Pick<BookingInput, "customerName" | "phone" | "partySize">): Fail | null {
  if (!i.customerName.trim()) return fail("FIELD", "請填寫預約姓名。", "customerName");
  if (i.customerName.trim().length > 50) return fail("FIELD", "姓名請在 50 字以內。", "customerName");
  const p = normalizePhone(i.phone);
  if (!/^0\d{8,9}$/.test(p)) return fail("FIELD", "請填寫有效電話（手機 09 開頭或含區碼市話，可加分機）。", "phone");
  if (!Number.isInteger(i.partySize) || i.partySize < 1 || i.partySize > 50) return fail("FIELD", "人數需為 1 以上的整數。", "partySize");
  return null;
}

function validateItem(ref: Ref, itemId: string): Fail | null {
  return ref.items.some((i) => i.id === itemId && i.active) ? null : fail("FIELD", "請選擇預約項目。", "itemId");
}

function validateSlotInput(date: string, start: string): Fail | null {
  if (!DATE.test(date) || Number.isNaN(Date.parse(date))) return fail("FIELD", "請選擇日期。", "start");
  if (!/^([01]\d|2[0-3]):00$/.test(start)) return fail("NOT_ON_HOUR", undefined, "start");
  return null;
}

/** 同一支電話的其他未來有效預約（最多 5 筆，供重複警告與通知內容） */
function futureBookingsWithPhone(q: Q, phone: string, excludeId?: string): Promise<Appointment[]> {
  return repo.listAppointments(q, { phoneNormalized: normalizePhone(phone), status: "active", dateFrom: todayTaipei(), excludeId, limit: 5 });
}

/** 依可約時段結果決定醫師；多位醫師時須指定 */
function pickDoctor(slot: Slot, requiresDoctor: boolean, doctorId: string | null): string | null | Fail {
  if (!requiresDoctor) return null;
  if (doctorId) return slot.doctorIds.includes(doctorId) ? doctorId : fail("NO_DOCTOR");
  if (slot.doctorIds.length === 1) return slot.doctorIds[0];
  if (slot.doctorIds.length === 0) return fail("NO_DOCTOR");
  return fail("FIELD", "此時段有多位醫師，請選擇安排的醫師。", "doctorId");
}

// ---------- 業務：新建（TRANSACTION） ----------

export type CreateResult = { ok: true; id: string } | Fail | { ok: false; code: "DUPLICATE_PHONE"; message: string };

export function createSalesAppointment(actor: UserAccount, salespersonId: string, input: BookingInput, idemKey: string, confirmDuplicate: boolean): Promise<CreateResult> {
  return bookingTx(async (c): Promise<CreateResult> => {
    // 重送同一請求：回傳原結果，不新增第二筆（同一個 key 的並行請求在這裡排隊）
    await repo.lockKey(c.q, `idem:${idemKey}`);
    const done = await repo.findIdempotent(c.q, idemKey);
    if (done) return { ok: true, id: done };

    const bad = validateBasics(input) ?? validateItem(c.ref, input.itemId) ?? validateSlotInput(input.date, input.start);
    if (bad) return bad;

    const rule = checkSalesCreate({ now: new Date(), date: input.date, start: input.start, maxDays: c.ref.settings.maxDays });
    if (!rule.ok) return fail(rule.reason, undefined, "start");

    await repo.lockSlot(c.q, input.date, input.start);
    const slot = (await slotsFor(c, input.date, input.requiresDoctor)).find((s) => s.start === input.start);
    if (!slot) return fail("OUTSIDE_HOURS", undefined, "start");
    if (!slot.available) return fail(slot.reason ?? "FULL", undefined, "start");

    const doctor = pickDoctor(slot, input.requiresDoctor, input.doctorId);
    if (doctor !== null && typeof doctor === "object") return doctor;

    const samePhone = await futureBookingsWithPhone(c.q, input.phone);
    const dup = samePhone.length > 0;
    if (dup && !confirmDuplicate) return { ok: false, code: "DUPLICATE_PHONE", message: "此電話已有預約，確定要再建立一筆嗎？" };

    const now = new Date().toISOString();
    const a: Appointment = {
      id: repo.newId(), code: await newCode(c, input.date),
      customerName: input.customerName.trim(), phone: input.phone.trim(), phoneNormalized: normalizePhone(input.phone),
      date: input.date, start: input.start, end: endOf(input.start), itemId: input.itemId, partySize: input.partySize,
      requiresDoctor: input.requiresDoctor, assignedDoctorId: doctor,
      preferredDoctorNote: input.preferredDoctorNote.trim(), careNote: input.careNote.trim(),
      salespersonId, status: "active", isOverbooked: false, overbookReason: "",
      conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "",
      createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now, cancelledAt: null, version: 1,
    };
    await repo.insertAppointment(c.q, a);
    await repo.saveIdempotent(c.q, idemKey, a.id);
    await audit(c, a.id, actor, "create");
    if (dup) await notify(c, "duplicate_phone", a, actor, `重複電話預約：${a.customerName} ${a.phone}（${namesOf(c.ref).salespersonName(salespersonId)}）`, { related: samePhone });
    return { ok: true, id: a.id };
  });
}

// ---------- 業務：修改／改期／取消（TRANSACTION） ----------

export type EditResult = { ok: true } | Fail;

export function updateSalesAppointment(actor: UserAccount, salespersonId: string, id: string, version: number, changes: SalesChanges & { doctorId?: string | null }): Promise<EditResult> {
  return bookingTx(async (c): Promise<EditResult> => {
    const found = await repo.findAppointment(c.q, id, true);
    if (!found || found.salespersonId !== salespersonId) return fail("NOT_FOUND", "找不到此預約。");
    if (found.version !== version) return fail("VERSION");
    const a = { ...found };

    const { doctorId, ...ruleChanges } = changes;
    if (ruleChanges.customerName !== undefined || ruleChanges.phone !== undefined || ruleChanges.partySize !== undefined) {
      const bad = validateBasics({
        customerName: ruleChanges.customerName ?? a.customerName, phone: ruleChanges.phone ?? a.phone, partySize: ruleChanges.partySize ?? a.partySize,
      });
      if (bad) return bad;
    }
    if (ruleChanges.itemId !== undefined) {
      const bad = validateItem(c.ref, ruleChanges.itemId);
      if (bad) return bad;
    }
    if (ruleChanges.time) {
      const bad = validateSlotInput(ruleChanges.time.date, ruleChanges.time.start);
      if (bad) return bad;
    }

    const r = checkSalesEdit({
      now: new Date(), maxDays: c.ref.settings.maxDays, changes: ruleChanges,
      appointment: { date: a.date, start: a.start, status: a.status, conflictStatus: a.conflictStatus },
    });
    if (!r.ok) return fail(r.reason);

    const now = new Date().toISOString();

    if (ruleChanges.cancel) {
      a.status = "cancelled";
      a.cancelledAt = now;
    } else {
      const newDate = ruleChanges.time?.date ?? a.date;
      const newStart = ruleChanges.time?.start ?? a.start;
      const newRequires = ruleChanges.requiresDoctor ?? a.requiresDoctor;
      const timeChanged = newDate !== a.date || newStart !== a.start;

      if (timeChanged) {
        // 改到別的時段：一般容量規則，只能去空的時段（超額位置不保留）
        await repo.lockSlot(c.q, newDate, newStart);
        const slot = (await slotsFor(c, newDate, newRequires, a.id)).find((s) => s.start === newStart);
        if (!slot || !slot.available) return fail(slot?.reason ?? "OUTSIDE_HOURS");
        const doctor = pickDoctor(slot, newRequires, doctorId ?? null);
        if (doctor !== null && typeof doctor === "object") return doctor;
        Object.assign(a, { date: newDate, start: newStart, end: endOf(newStart), assignedDoctorId: doctor, isOverbooked: false, overbookReason: "" });
      } else if (ruleChanges.requiresDoctor !== undefined && ruleChanges.requiresDoctor !== found.requiresDoctor) {
        if (newRequires) {
          // 改成需醫師：同一時段要有醫師班表（容量不變）
          const hour = (await slotsFor(c, a.date, true, a.id)).find((s) => s.start === a.start);
          const doctor = hour ? pickDoctor({ ...hour, available: true }, true, doctorId ?? null) : fail("NO_DOCTOR");
          if (doctor !== null && typeof doctor === "object") return doctor;
          a.assignedDoctorId = doctor;
        } else {
          a.assignedDoctorId = null;
        }
      }
      a.requiresDoctor = newRequires;
      if (ruleChanges.itemId !== undefined) a.itemId = ruleChanges.itemId;
      if (ruleChanges.customerName !== undefined) a.customerName = ruleChanges.customerName.trim();
      if (ruleChanges.phone !== undefined) { a.phone = ruleChanges.phone.trim(); a.phoneNormalized = normalizePhone(ruleChanges.phone); }
      if (ruleChanges.partySize !== undefined) a.partySize = ruleChanges.partySize;
      if (ruleChanges.careNote !== undefined) a.careNote = ruleChanges.careNote.trim();
      if (ruleChanges.preferredDoctorNote !== undefined) a.preferredDoctorNote = ruleChanges.preferredDoctorNote.trim();

      // 衝突預約處理後重新判斷，可能自動解除
      if (a.conflictStatus !== "none") {
        const cr = evaluateConflict({ ...a, keptReasons: a.conflictKeptReasons }, scheduleData(c.ref));
        a.conflictStatus = cr.conflictStatus;
        a.conflictReasons = cr.reasons;
      }
    }

    a.updatedBy = actor.id;
    a.updatedAt = now;
    a.version += 1;
    await save(c, a, version);
    const changed = diff(found, a);
    await audit(c, a.id, actor, ruleChanges.cancel ? "cancel" : "update", changed);

    const label = `${a.date} ${a.start} ${a.customerName}`;
    if (ruleChanges.cancel) await notify(c, "sales_cancel", a, actor, `${actor.displayName} 取消預約：${label}`, { changes: changed });
    else if (r.notifyWithin4h) await notify(c, "sales_edit_within_4h", a, actor, `${actor.displayName} 於 4 小時內修改：${label}`, { changes: changed });
    else await notify(c, "sales_edit", a, actor, `${actor.displayName} 修改預約：${label}`, { changes: changed });
    return { ok: true };
  });
}

function diff(before: Appointment, after: Appointment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after) as (keyof Appointment)[]) {
    if (["updatedAt", "updatedBy", "version", "phoneNormalized"].includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      // 照護備註只記「已修改」，不記全文（規格 8）
      out[k] = k === "careNote" ? "（已修改）" : { from: before[k], to: after[k] };
    }
  }
  return out;
}

// ---------- 店長／代理店長（TRANSACTION） ----------

export type AdminCreateInput = BookingInput & { salespersonId: string; overbookReason: string; acknowledgedWarnings: boolean };
export type AdminCreateOutcome = { ok: true; id: string } | Fail | { ok: false; code: "NEEDS_CONFIRMATION"; message: string };

export function createAdminAppointment(actor: UserAccount, input: AdminCreateInput, idemKey: string): Promise<AdminCreateOutcome> {
  return bookingTx(async (c): Promise<AdminCreateOutcome> => {
    await repo.lockKey(c.q, `idem:${idemKey}`);
    const done = await repo.findIdempotent(c.q, idemKey);
    if (done) return { ok: true, id: done };
    const bad = validateBasics(input) ?? validateItem(c.ref, input.itemId) ?? validateSlotInput(input.date, input.start);
    if (bad) return bad;
    if (!c.ref.salespeople.some((s) => s.id === input.salespersonId && s.active)) return fail("FIELD", "請選擇負責業務。", "salespersonId");

    await repo.lockSlot(c.q, input.date, input.start);
    const r = checkAdminCreate({
      now: new Date(), date: input.date, start: input.start, requiresDoctor: input.requiresDoctor,
      requestedDoctorId: input.doctorId, overbookReason: input.overbookReason, acknowledgedWarnings: input.acknowledgedWarnings,
      existing: await repo.listAppointments(c.q, { date: input.date, start: input.start }), schedule: scheduleData(c.ref),
    });
    if (!r.ok) {
      if (r.reason === "NEEDS_CONFIRMATION") return { ok: false, code: "NEEDS_CONFIRMATION", message: "同一時段醫師已有其他預約，確定仍要加開？" };
      return fail(r.reason, undefined, r.reason === "REASON_REQUIRED" ? "overbookReason" : "start");
    }

    const now = new Date().toISOString();
    const a: Appointment = {
      id: repo.newId(), code: await newCode(c, input.date),
      customerName: input.customerName.trim(), phone: input.phone.trim(), phoneNormalized: normalizePhone(input.phone),
      date: input.date, start: input.start, end: endOf(input.start), itemId: input.itemId, partySize: input.partySize,
      requiresDoctor: input.requiresDoctor, assignedDoctorId: r.assignedDoctorId,
      preferredDoctorNote: input.preferredDoctorNote.trim(), careNote: input.careNote.trim(),
      salespersonId: input.salespersonId, status: "active", isOverbooked: r.isOverbooked, overbookReason: r.isOverbooked ? input.overbookReason.trim() : "",
      conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "",
      createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now, cancelledAt: null, version: 1,
    };
    await repo.insertAppointment(c.q, a);
    await repo.saveIdempotent(c.q, idemKey, a.id);
    await audit(c, a.id, actor, r.isOverbooked ? "overbook" : "create", { warnings: r.warnings }, a.overbookReason);
    await notifyIfDeputy(c, actor, a, r.isOverbooked ? " 加開預約" : " 新增預約");
    return { ok: true, id: a.id };
  });
}

/** 店長類修改的共用開頭：鎖列、比對版本 */
async function lockForManager(c: Ctx, id: string, version: number): Promise<Appointment | Fail> {
  const a = await repo.findAppointment(c.q, id, true);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");
  return a;
}
const isFail = (x: Appointment | Fail): x is Fail => "ok" in x;

export function adminSetStatus(actor: UserAccount, id: string, version: number, status: "completed" | "no_show" | "cancelled" | "active"): Promise<EditResult> {
  return bookingTx(async (c): Promise<EditResult> => {
    const found = await lockForManager(c, id, version);
    if (isFail(found)) return found;
    const a = { ...found };
    if (!["completed", "no_show", "cancelled", "active"].includes(status)) return fail("FIELD", "未知的狀態。");
    const started = minutesUntil(new Date(), a.date, a.start) <= 0;
    if ((status === "completed" || status === "no_show") && !started) return fail("NOT_STARTED", "時段開始後才能標記到診狀態。");
    if (status === "cancelled" && a.status === "cancelled") return fail("NO_CHANGES");
    if (status === "active" && a.status === "cancelled") return fail("FIELD", "已取消的預約請重新建立。");
    const from = a.status;
    a.status = status;
    if (status === "cancelled") a.cancelledAt = new Date().toISOString();
    a.updatedBy = actor.id; a.updatedAt = new Date().toISOString(); a.version += 1;
    await save(c, a, version);
    await audit(c, a.id, actor, `status:${status}`, { status: { from, to: status } });
    await notifyIfDeputy(c, actor, a, ` 將狀態改為 ${status}`, diff(found, a));
    return { ok: true };
  });
}

export function adminKeepConflict(actor: UserAccount, id: string, version: number, note: string): Promise<EditResult> {
  return bookingTx(async (c): Promise<EditResult> => {
    const found = await lockForManager(c, id, version);
    if (isFail(found)) return found;
    const a = { ...found };
    if (a.conflictStatus !== "conflict") return fail("NO_CHANGES", "此預約目前沒有衝突。");
    if (!note.trim()) return fail("FIELD", "請填寫保留原因。", "note");
    a.conflictStatus = "kept";
    a.conflictKeptReasons = [...a.conflictReasons];
    a.conflictKeptNote = note.trim();
    a.updatedBy = actor.id; a.updatedAt = new Date().toISOString(); a.version += 1;
    await save(c, a, version);
    await audit(c, a.id, actor, "keep-conflict", {}, note.trim());
    await notifyIfDeputy(c, actor, a, " 標記衝突保留", diff(found, a));
    return { ok: true };
  });
}

export function adminReassign(actor: UserAccount, id: string, version: number, salespersonId: string): Promise<EditResult> {
  return bookingTx(async (c): Promise<EditResult> => {
    const found = await lockForManager(c, id, version);
    if (isFail(found)) return found;
    const a = { ...found };
    if (!c.ref.salespeople.some((s) => s.id === salespersonId && s.active)) return fail("FIELD", "請選擇啟用中的業務。");
    const from = a.salespersonId;
    a.salespersonId = salespersonId;
    a.updatedBy = actor.id; a.updatedAt = new Date().toISOString(); a.version += 1;
    await save(c, a, version);
    await audit(c, a.id, actor, "reassign", { salespersonId: { from, to: salespersonId } });
    await notifyIfDeputy(c, actor, a, " 轉換負責業務", diff(found, a));
    return { ok: true };
  });
}

// ---------- 班表異動與衝突重算（僅店長；由 admin.ts 在班表獨占鎖的交易內呼叫） ----------

/** 只有尚未開始的有效預約需要重算；往前多抓一天避免時區邊界漏掉 */
async function recomputeCandidates(q: Q) {
  const list = await repo.listAppointments(q, { status: "active", dateFrom: addDays(todayTaipei(), -1) });
  return list.map((a) => ({ ...a, keptReasons: a.conflictKeptReasons }));
}

/** 儲存前預覽：用尚未儲存的新班表算出會變成衝突的預約 */
export async function previewConflicts(q: Q, ref: Ref, next: ScheduleData): Promise<(ConflictChange & { label: string })[]> {
  const list = await recomputeCandidates(q);
  const { salespersonName } = namesOf(ref);
  return recomputeConflicts({ now: new Date(), appointments: list, schedule: next })
    .filter((c) => c.to === "conflict")
    .map((c) => {
      const a = list.find((x) => x.id === c.id)!;
      return { ...c, label: `${a.date} ${a.start}　${a.customerName}（${salespersonName(a.salespersonId)}）` };
    });
}

/** 儲存後呼叫（同一交易內，ref 為已寫入的新班表）：寫回衝突狀態 */
export async function applyConflictRecompute(q: Q, ref: Ref, actor: UserAccount): Promise<number> {
  const list = await recomputeCandidates(q);
  const changes = recomputeConflicts({ now: new Date(), appointments: list, schedule: scheduleData(ref) });
  for (const ch of changes) {
    const { keptReasons: _k, ...found } = list.find((x) => x.id === ch.id)!;
    const a: Appointment = { ...found, conflictStatus: ch.to, conflictReasons: ch.reasons, version: found.version + 1 };
    if (ch.to === "none") { a.conflictKeptReasons = []; a.conflictKeptNote = ""; }
    if (!(await repo.saveAppointment(q, a, found.version))) throw new Error(`appointment ${a.id} changed during recompute`);
    await repo.insertAudit(q, {
      entityType: "appointment", entityId: a.id, actorUserId: actor.id, action: "conflict-recompute",
      changes: { conflictStatus: { from: ch.from, to: ch.to }, reasons: ch.reasons }, reason: "",
    });
  }
  return changes.length;
}

export function canManage(role: Role) {
  return role === "admin" || role === "deputy";
}

/** 店長改期：與新建同一套檢查（可加開、需原因、醫師撞時段需確認） */
export function adminReschedule(actor: UserAccount, id: string, version: number, date: string, start: string, doctorId: string | null, overbookReason: string, acknowledgedWarnings: boolean): Promise<AdminCreateOutcome> {
  return bookingTx(async (c): Promise<AdminCreateOutcome> => {
    const found = await lockForManager(c, id, version);
    if (isFail(found)) return found;
    if (found.status !== "active") return fail("NOT_ACTIVE");
    const bad = validateSlotInput(date, start);
    if (bad) return bad;
    await repo.lockSlot(c.q, date, start);
    const r = checkAdminCreate({
      now: new Date(), date, start, requiresDoctor: found.requiresDoctor, requestedDoctorId: doctorId,
      overbookReason, acknowledgedWarnings, schedule: scheduleData(c.ref),
      existing: await repo.listAppointments(c.q, { date, start, excludeId: found.id }),
    });
    if (!r.ok) {
      if (r.reason === "NEEDS_CONFIRMATION") return { ok: false, code: "NEEDS_CONFIRMATION", message: "同一時段醫師已有其他預約，確定仍要改到這裡？" };
      return fail(r.reason);
    }
    const a: Appointment = {
      ...found,
      date, start, end: endOf(start), assignedDoctorId: r.assignedDoctorId, isOverbooked: r.isOverbooked,
      overbookReason: r.isOverbooked ? overbookReason.trim() : "", conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "",
      updatedBy: actor.id, updatedAt: new Date().toISOString(), version: found.version + 1,
    };
    await save(c, a, version);
    await audit(c, a.id, actor, "reschedule", diff(found, a), a.overbookReason);
    await notifyIfDeputy(c, actor, a, " 改期", diff(found, a));
    return { ok: true, id: a.id };
  });
}

/** 店長修改客戶資料、人數、備註、項目（不受時間限制，但已取消者不可） */
export function adminUpdateBasics(actor: UserAccount, id: string, version: number, v: { customerName: string; phone: string; partySize: number; itemId: string; careNote: string; preferredDoctorNote: string }): Promise<EditResult> {
  return bookingTx(async (c): Promise<EditResult> => {
    const found = await lockForManager(c, id, version);
    if (isFail(found)) return found;
    if (found.status === "cancelled") return fail("NOT_ACTIVE");
    const bad = validateBasics(v) ?? (v.itemId !== found.itemId ? validateItem(c.ref, v.itemId) : null);
    if (bad) return bad;
    const a: Appointment = {
      ...found,
      customerName: v.customerName.trim(), phone: v.phone.trim(), phoneNormalized: normalizePhone(v.phone), partySize: v.partySize,
      itemId: v.itemId, careNote: v.careNote.trim(), preferredDoctorNote: v.preferredDoctorNote.trim(),
      updatedBy: actor.id, updatedAt: new Date().toISOString(), version: found.version + 1,
    };
    await save(c, a, version);
    await audit(c, a.id, actor, "update", diff(found, a));
    await notifyIfDeputy(c, actor, a, " 修改預約", diff(found, a));
    return { ok: true };
  });
}
