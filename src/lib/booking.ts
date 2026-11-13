import "server-only";
/**
 * 預約服務層：所有預約讀寫都經過這裡，規則一律交給 lib/domain（有單元測試）。
 *
 * 【並行安全】記憶體版本的每個寫入函式都是同步執行（中間沒有 await），
 * Node.js 單執行緒下等同一個交易，兩個請求不會交錯。
 * 換成 Supabase 時，每個標註「TRANSACTION」的函式都必須包成一個資料庫交易，
 * 並在讀取時段前取得 pg_advisory_xact_lock(hashtext(date || start))。
 */
import { db, nextId } from "@/lib/data/store";
import type { Appointment, NotifyEvent, Role, UserAccount } from "@/lib/data/types";
import type { ScheduleData } from "@/lib/domain/schedule";
import { computeSlots, type Slot } from "@/lib/domain/slots";
import { checkSalesCreate, checkSalesEdit, OCCUPYING_STATUSES, type SalesChanges } from "@/lib/domain/rules";
import { checkAdminCreate } from "@/lib/domain/admin-create";
import { evaluateConflict, recomputeConflicts, type ConflictChange } from "@/lib/domain/conflicts";
import { normalizePhone } from "@/lib/domain/phone";
import { addDays, minutesUntil, toTaipei } from "@/lib/domain/time";
import { endOf, RULE_MESSAGE } from "@/lib/format";

export type Fail = { ok: false; code: string; message: string; field?: string };
const fail = (code: string, message = RULE_MESSAGE[code] ?? "操作失敗，請稍後再試。", field?: string): Fail => ({ ok: false, code, message, field });

// ---------- 讀取 ----------

export function scheduleData(): ScheduleData {
  return { openings: db.openings, doctors: db.doctors, doctorShifts: db.shifts, blocks: db.blocks };
}

export function occupiedStarts(date: string, excludeId?: string): string[] {
  return db.appointments
    .filter((a) => a.date === date && a.id !== excludeId && OCCUPYING_STATUSES.includes(a.status))
    .map((a) => a.start);
}

export const itemName = (id: string) => db.items.find((i) => i.id === id)?.name ?? "（已刪除項目）";
export const doctorName = (id: string | null) => (id ? db.doctors.find((d) => d.id === id)?.displayName ?? "—" : "—");
export const salespersonName = (id: string) => db.salespeople.find((s) => s.id === id)?.displayName ?? "—";
export const userName = (id: string) => db.users.find((u) => u.id === id)?.displayName ?? "系統";

export function salesSlots(date: string, requiresDoctor: boolean, excludeId?: string): Slot[] {
  return computeSlots({
    now: new Date(), maxDays: db.settings.maxDays, date, requiresDoctor,
    occupiedStarts: occupiedStarts(date, excludeId), schedule: scheduleData(),
  });
}

/** 某月每一天是否還有可約時段（日期元件停用用） */
export function monthAvailability(year: number, month: number, requiresDoctor: boolean, excludeId?: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    out[date] = salesSlots(date, requiresDoctor, excludeId).some((s) => s.available);
  }
  return out;
}

export function todayTaipei(): string {
  return toTaipei(new Date()).date;
}
export function maxBookableDate(): string {
  return addDays(todayTaipei(), db.settings.maxDays);
}

/** 業務只能看負責業務是自己的預約；找不到一律回 null（不透露是否存在） */
export function getOwnAppointment(salespersonId: string, id: string): Appointment | null {
  const a = db.appointments.find((x) => x.id === id);
  return a && a.salespersonId === salespersonId ? a : null;
}

export function listOwnAppointments(salespersonId: string): Appointment[] {
  const today = todayTaipei();
  return db.appointments
    .filter((a) => a.salespersonId === salespersonId && a.date >= today)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// ---------- 通知與稽核 ----------

function notify(event: NotifyEvent, appointmentId: string | null, actor: UserAccount, summary: string) {
  const mode = db.settings.notifyModes[event];
  db.notifications.unshift({ id: nextId("n"), event, appointmentId, actorUserId: actor.id, summary, mode, readAt: null, createdAt: new Date().toISOString() });
  // TODO（交給 Claude Code）：mode === "instant" 時以 Resend 寄信給 db.settings.notifyEmails；失敗記錄並重試，不影響預約結果。
}

function audit(entityType: "appointment" | "schedule" | "settings" | "account" | "item" | "doctor" | "salesperson", entityId: string, actor: UserAccount, action: string, changes: Record<string, unknown> = {}, reason = "") {
  db.audit.unshift({ id: nextId("log"), entityType, entityId, actorUserId: actor.id, action, changes, reason, createdAt: new Date().toISOString() });
}

/** 代理店長的每個預約操作都要通知店長（規格 7.4） */
function notifyIfDeputy(actor: UserAccount, a: Appointment, what: string) {
  if (actor.role === "deputy") notify("deputy_action", a.id, actor, `${actor.displayName}${what}：${a.date} ${a.start} ${a.customerName}`);
}

function newCode(date: string): string {
  const n = db.appointments.filter((a) => a.date === date).length + 1;
  return `PI-${date.replaceAll("-", "")}-${String(n).padStart(3, "0")}`;
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

function validateBasics(i: Pick<BookingInput, "customerName" | "phone" | "partySize">): Fail | null {
  if (!i.customerName.trim()) return fail("FIELD", "請填寫預約姓名。", "customerName");
  if (i.customerName.trim().length > 50) return fail("FIELD", "姓名請在 50 字以內。", "customerName");
  const p = normalizePhone(i.phone);
  if (!/^0\d{8,9}$/.test(p)) return fail("FIELD", "請填寫有效電話（手機 09 開頭或含區碼市話，可加分機）。", "phone");
  if (!Number.isInteger(i.partySize) || i.partySize < 1 || i.partySize > 50) return fail("FIELD", "人數需為 1 以上的整數。", "partySize");
  return null;
}

function validateItem(itemId: string): Fail | null {
  return db.items.some((i) => i.id === itemId && i.active) ? null : fail("FIELD", "請選擇預約項目。", "itemId");
}

export function hasFutureBookingWithPhone(phone: string, excludeId?: string): boolean {
  const p = normalizePhone(phone);
  const today = todayTaipei();
  return db.appointments.some((a) => a.id !== excludeId && a.status === "active" && a.phoneNormalized === p && a.date >= today);
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

export function createSalesAppointment(actor: UserAccount, salespersonId: string, input: BookingInput, idemKey: string, confirmDuplicate: boolean): CreateResult {
  const done = db.idempotency.get(idemKey);
  if (done) return { ok: true, id: done }; // 重送同一請求：回傳原結果，不新增第二筆

  const bad = validateBasics(input) ?? validateItem(input.itemId);
  if (bad) return bad;

  const rule = checkSalesCreate({ now: new Date(), date: input.date, start: input.start, maxDays: db.settings.maxDays });
  if (!rule.ok) return fail(rule.reason, undefined, "start");

  const slot = salesSlots(input.date, input.requiresDoctor).find((s) => s.start === input.start);
  if (!slot) return fail("OUTSIDE_HOURS", undefined, "start");
  if (!slot.available) return fail(slot.reason ?? "FULL", undefined, "start");

  const doctor = pickDoctor(slot, input.requiresDoctor, input.doctorId);
  if (doctor !== null && typeof doctor === "object") return doctor;

  const dup = hasFutureBookingWithPhone(input.phone);
  if (dup && !confirmDuplicate) return { ok: false, code: "DUPLICATE_PHONE", message: "此電話已有預約，確定要再建立一筆嗎？" };

  const now = new Date().toISOString();
  const a: Appointment = {
    id: nextId("a"), code: newCode(input.date),
    customerName: input.customerName.trim(), phone: input.phone.trim(), phoneNormalized: normalizePhone(input.phone),
    date: input.date, start: input.start, end: endOf(input.start), itemId: input.itemId, partySize: input.partySize,
    requiresDoctor: input.requiresDoctor, assignedDoctorId: doctor,
    preferredDoctorNote: input.preferredDoctorNote.trim(), careNote: input.careNote.trim(),
    salespersonId, status: "active", isOverbooked: false, overbookReason: "",
    conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "",
    createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now, cancelledAt: null, version: 1,
  };
  db.appointments.push(a);
  db.idempotency.set(idemKey, a.id);
  audit("appointment", a.id, actor, "create");
  if (dup) notify("duplicate_phone", a.id, actor, `重複電話預約：${a.customerName} ${a.phone}（${salespersonName(salespersonId)}）`);
  return { ok: true, id: a.id };
}

// ---------- 業務：修改／改期／取消（TRANSACTION） ----------

export type EditResult = { ok: true } | Fail;

export function updateSalesAppointment(actor: UserAccount, salespersonId: string, id: string, version: number, changes: SalesChanges & { doctorId?: string | null }): EditResult {
  const a = getOwnAppointment(salespersonId, id);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");

  const { doctorId, ...ruleChanges } = changes;
  if (ruleChanges.customerName !== undefined || ruleChanges.phone !== undefined || ruleChanges.partySize !== undefined) {
    const bad = validateBasics({
      customerName: ruleChanges.customerName ?? a.customerName, phone: ruleChanges.phone ?? a.phone, partySize: ruleChanges.partySize ?? a.partySize,
    });
    if (bad) return bad;
  }
  if (ruleChanges.itemId !== undefined) {
    const bad = validateItem(ruleChanges.itemId);
    if (bad) return bad;
  }

  const r = checkSalesEdit({
    now: new Date(), maxDays: db.settings.maxDays, changes: ruleChanges,
    appointment: { date: a.date, start: a.start, status: a.status, conflictStatus: a.conflictStatus },
  });
  if (!r.ok) return fail(r.reason);

  const before = { ...a };
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
      const slot = salesSlots(newDate, newRequires, a.id).find((s) => s.start === newStart);
      if (!slot || !slot.available) return fail(slot?.reason ?? "OUTSIDE_HOURS");
      const doctor = pickDoctor(slot, newRequires, doctorId ?? null);
      if (doctor !== null && typeof doctor === "object") return doctor;
      Object.assign(a, { date: newDate, start: newStart, end: endOf(newStart), assignedDoctorId: doctor, isOverbooked: false, overbookReason: "" });
    } else if (ruleChanges.requiresDoctor !== undefined && ruleChanges.requiresDoctor !== before.requiresDoctor) {
      if (newRequires) {
        // 改成需醫師：同一時段要有醫師班表（容量不變）
        const hour = salesSlots(a.date, true, a.id).find((s) => s.start === a.start);
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
      const c = evaluateConflict({ ...a, keptReasons: a.conflictKeptReasons }, scheduleData());
      a.conflictStatus = c.conflictStatus;
      a.conflictReasons = c.reasons;
    }
  }

  a.updatedBy = actor.id;
  a.updatedAt = now;
  a.version += 1;
  audit("appointment", a.id, actor, ruleChanges.cancel ? "cancel" : "update", diff(before, a));

  const label = `${a.date} ${a.start} ${a.customerName}`;
  if (ruleChanges.cancel) notify("sales_cancel", a.id, actor, `${actor.displayName} 取消預約：${label}`);
  else if (r.notifyWithin4h) notify("sales_edit_within_4h", a.id, actor, `${actor.displayName} 於 4 小時內修改：${label}`);
  else notify("sales_edit", a.id, actor, `${actor.displayName} 修改預約：${label}`);
  return { ok: true };
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

export function createAdminAppointment(actor: UserAccount, input: AdminCreateInput, idemKey: string): AdminCreateOutcome {
  const done = db.idempotency.get(idemKey);
  if (done) return { ok: true, id: done };
  const bad = validateBasics(input) ?? validateItem(input.itemId);
  if (bad) return bad;
  if (!db.salespeople.some((s) => s.id === input.salespersonId && s.active)) return fail("FIELD", "請選擇負責業務。", "salespersonId");

  const r = checkAdminCreate({
    now: new Date(), date: input.date, start: input.start, requiresDoctor: input.requiresDoctor,
    requestedDoctorId: input.doctorId, overbookReason: input.overbookReason, acknowledgedWarnings: input.acknowledgedWarnings,
    existing: db.appointments.filter((a) => a.date === input.date && a.start === input.start), schedule: scheduleData(),
  });
  if (!r.ok) {
    if (r.reason === "NEEDS_CONFIRMATION") return { ok: false, code: "NEEDS_CONFIRMATION", message: "同一時段醫師已有其他預約，確定仍要加開？" };
    return fail(r.reason, undefined, r.reason === "REASON_REQUIRED" ? "overbookReason" : "start");
  }

  const now = new Date().toISOString();
  const a: Appointment = {
    id: nextId("a"), code: newCode(input.date),
    customerName: input.customerName.trim(), phone: input.phone.trim(), phoneNormalized: normalizePhone(input.phone),
    date: input.date, start: input.start, end: endOf(input.start), itemId: input.itemId, partySize: input.partySize,
    requiresDoctor: input.requiresDoctor, assignedDoctorId: r.assignedDoctorId,
    preferredDoctorNote: input.preferredDoctorNote.trim(), careNote: input.careNote.trim(),
    salespersonId: input.salespersonId, status: "active", isOverbooked: r.isOverbooked, overbookReason: r.isOverbooked ? input.overbookReason.trim() : "",
    conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "",
    createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now, cancelledAt: null, version: 1,
  };
  db.appointments.push(a);
  db.idempotency.set(idemKey, a.id);
  audit("appointment", a.id, actor, r.isOverbooked ? "overbook" : "create", { warnings: r.warnings }, a.overbookReason);
  notifyIfDeputy(actor, a, r.isOverbooked ? " 加開預約" : " 新增預約");
  return { ok: true, id: a.id };
}

export function adminSetStatus(actor: UserAccount, id: string, version: number, status: "completed" | "no_show" | "cancelled" | "active"): EditResult {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");
  const started = minutesUntil(new Date(), a.date, a.start) <= 0;
  if ((status === "completed" || status === "no_show") && !started) return fail("NOT_STARTED", "時段開始後才能標記到診狀態。");
  if (status === "cancelled" && a.status === "cancelled") return fail("NO_CHANGES");
  if (status === "active" && a.status === "cancelled") return fail("FIELD", "已取消的預約請重新建立。");
  const from = a.status;
  a.status = status;
  if (status === "cancelled") a.cancelledAt = new Date().toISOString();
  a.updatedBy = actor.id; a.updatedAt = new Date().toISOString(); a.version += 1;
  audit("appointment", a.id, actor, `status:${status}`, { status: { from, to: status } });
  notifyIfDeputy(actor, a, ` 將狀態改為 ${status}`);
  return { ok: true };
}

export function adminKeepConflict(actor: UserAccount, id: string, version: number, note: string): EditResult {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");
  if (a.conflictStatus !== "conflict") return fail("NO_CHANGES", "此預約目前沒有衝突。");
  if (!note.trim()) return fail("FIELD", "請填寫保留原因。", "note");
  a.conflictStatus = "kept";
  a.conflictKeptReasons = [...a.conflictReasons];
  a.conflictKeptNote = note.trim();
  a.updatedBy = actor.id; a.updatedAt = new Date().toISOString(); a.version += 1;
  audit("appointment", a.id, actor, "keep-conflict", {}, note.trim());
  notifyIfDeputy(actor, a, " 標記衝突保留");
  return { ok: true };
}

export function adminReassign(actor: UserAccount, id: string, version: number, salespersonId: string): EditResult {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");
  if (!db.salespeople.some((s) => s.id === salespersonId && s.active)) return fail("FIELD", "請選擇啟用中的業務。");
  const from = a.salespersonId;
  a.salespersonId = salespersonId;
  a.updatedBy = actor.id; a.updatedAt = new Date().toISOString(); a.version += 1;
  audit("appointment", a.id, actor, "reassign", { salespersonId: { from, to: salespersonId } });
  notifyIfDeputy(actor, a, " 轉換負責業務");
  return { ok: true };
}

// ---------- 班表異動與衝突重算（僅店長） ----------

function futureActive() {
  return db.appointments.map((a) => ({ ...a, keptReasons: a.conflictKeptReasons }));
}

/** 儲存前預覽：用尚未儲存的新班表算出會變成衝突的預約 */
export function previewConflicts(next: ScheduleData): (ConflictChange & { label: string })[] {
  return recomputeConflicts({ now: new Date(), appointments: futureActive(), schedule: next })
    .filter((c) => c.to === "conflict")
    .map((c) => {
      const a = db.appointments.find((x) => x.id === c.id)!;
      return { ...c, label: `${a.date} ${a.start}　${a.customerName}（${salespersonName(a.salespersonId)}）` };
    });
}

/** 儲存後呼叫：寫回衝突狀態 */
export function applyConflictRecompute(actor: UserAccount): number {
  const changes = recomputeConflicts({ now: new Date(), appointments: futureActive(), schedule: scheduleData() });
  for (const c of changes) {
    const a = db.appointments.find((x) => x.id === c.id)!;
    a.conflictStatus = c.to;
    a.conflictReasons = c.reasons;
    if (c.to === "none") { a.conflictKeptReasons = []; a.conflictKeptNote = ""; }
    a.version += 1;
    audit("appointment", a.id, actor, "conflict-recompute", { conflictStatus: { from: c.from, to: c.to }, reasons: c.reasons });
  }
  return changes.length;
}

export function canManage(role: Role) {
  return role === "admin" || role === "deputy";
}

/** 店長改期：與新建同一套檢查（可加開、需原因、醫師撞時段需確認） */
export function adminReschedule(actor: UserAccount, id: string, version: number, date: string, start: string, doctorId: string | null, overbookReason: string, acknowledgedWarnings: boolean): AdminCreateOutcome {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");
  if (a.status !== "active") return fail("NOT_ACTIVE");
  const r = checkAdminCreate({
    now: new Date(), date, start, requiresDoctor: a.requiresDoctor, requestedDoctorId: doctorId,
    overbookReason, acknowledgedWarnings, schedule: scheduleData(),
    existing: db.appointments.filter((x) => x.id !== a.id && x.date === date && x.start === start),
  });
  if (!r.ok) {
    if (r.reason === "NEEDS_CONFIRMATION") return { ok: false, code: "NEEDS_CONFIRMATION", message: "同一時段醫師已有其他預約，確定仍要改到這裡？" };
    return fail(r.reason);
  }
  const before = { ...a };
  Object.assign(a, {
    date, start, end: endOf(start), assignedDoctorId: r.assignedDoctorId, isOverbooked: r.isOverbooked,
    overbookReason: r.isOverbooked ? overbookReason.trim() : "", conflictStatus: "none", conflictReasons: [], conflictKeptReasons: [], conflictKeptNote: "",
    updatedBy: actor.id, updatedAt: new Date().toISOString(), version: a.version + 1,
  });
  audit("appointment", a.id, actor, "reschedule", diff(before, a), a.overbookReason);
  notifyIfDeputy(actor, a, " 改期");
  return { ok: true, id: a.id };
}

/** 店長修改客戶資料、人數、備註、項目（不受時間限制，但已取消者不可） */
export function adminUpdateBasics(actor: UserAccount, id: string, version: number, v: { customerName: string; phone: string; partySize: number; itemId: string; careNote: string; preferredDoctorNote: string }): EditResult {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) return fail("NOT_FOUND", "找不到此預約。");
  if (a.version !== version) return fail("VERSION");
  if (a.status === "cancelled") return fail("NOT_ACTIVE");
  const bad = validateBasics(v) ?? (v.itemId !== a.itemId ? validateItem(v.itemId) : null);
  if (bad) return bad;
  const before = { ...a };
  Object.assign(a, {
    customerName: v.customerName.trim(), phone: v.phone.trim(), phoneNormalized: normalizePhone(v.phone), partySize: v.partySize,
    itemId: v.itemId, careNote: v.careNote.trim(), preferredDoctorNote: v.preferredDoctorNote.trim(),
    updatedBy: actor.id, updatedAt: new Date().toISOString(), version: a.version + 1,
  });
  audit("appointment", a.id, actor, "update", diff(before, a));
  notifyIfDeputy(actor, a, " 修改預約");
  return { ok: true };
}
