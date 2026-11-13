"use server";
/** 後台所有 Server Action。每個都在伺服器端重新檢查角色（規格 6）。 */
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import type { NotifyEvent, NotifyMode, Role } from "@/lib/data/types";
import {
  adminKeepConflict, adminReassign, adminReschedule, adminSetStatus, adminUpdateBasics, createAdminAppointment,
  type AdminCreateInput,
} from "@/lib/booking";
import * as admin from "@/lib/admin";

export type ActionState = { ok: boolean; message: string; data?: unknown } | null;

const managers = () => requireUser(["admin", "deputy"]);
const adminOnly = () => requireUser(["admin"]);
const s = (f: FormData, k: string) => String(f.get(k) ?? "");
const done = (ok: boolean, message: string, data?: unknown): ActionState => {
  if (ok) refresh();
  return { ok, message, data };
};

// ---------- 預約（店長、代理店長） ----------

export async function createByManager(input: AdminCreateInput, idemKey: string) {
  const me = await managers();
  const r = await createAdminAppointment(me.user, {
    ...input,
    partySize: Number(input.partySize), requiresDoctor: input.requiresDoctor === true, acknowledgedWarnings: input.acknowledgedWarnings === true,
    doctorId: input.doctorId || null,
  }, `${me.user.id}:${idemKey.slice(0, 64)}`);
  return r;
}

export async function setStatus(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await managers();
  const r = await adminSetStatus(me.user, s(f, "id"), Number(f.get("version")), s(f, "status") as "completed" | "no_show" | "cancelled");
  return done(r.ok, r.ok ? "狀態已更新。" : r.message);
}

export async function keepConflict(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await managers();
  const r = await adminKeepConflict(me.user, s(f, "id"), Number(f.get("version")), s(f, "note"));
  return done(r.ok, r.ok ? "已標記保留。" : r.message);
}

export async function reassign(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await managers();
  const r = await adminReassign(me.user, s(f, "id"), Number(f.get("version")), s(f, "salespersonId"));
  return done(r.ok, r.ok ? "已轉換負責業務。" : r.message);
}

export async function rescheduleByManager(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await managers();
  const r = await adminReschedule(me.user, s(f, "id"), Number(f.get("version")), s(f, "date"), s(f, "start"), s(f, "doctorId") || null, s(f, "overbookReason"), f.get("ack") === "1");
  if (!r.ok && r.code === "NEEDS_CONFIRMATION") return { ok: false, message: r.message, data: "confirm" };
  return done(r.ok, r.ok ? "已改期。" : r.message);
}

export async function editByManager(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await managers();
  const r = await adminUpdateBasics(me.user, s(f, "id"), Number(f.get("version")), {
    customerName: s(f, "customerName"), phone: s(f, "phone"), partySize: Number(f.get("partySize")), itemId: s(f, "itemId"),
    careNote: s(f, "careNote"), preferredDoctorNote: s(f, "preferredDoctorNote"),
  });
  return done(r.ok, r.ok ? "已儲存。" : r.message);
}

export async function markAllRead() {
  await managers();
  await admin.markAllNotificationsRead();
  refresh();
}

export async function resendDigestAction(_p: ActionState, f: FormData): Promise<ActionState> {
  await managers();
  const ok = await admin.resendDigestEmail(s(f, "id"));
  return done(ok, ok ? "已重新排入寄送。" : "此日報已寄出。");
}

/** 寄送失敗的即時信重新排入寄送（例如補上收件地址、修好寄件網域後） */
export async function resendEmailAction(_p: ActionState, f: FormData): Promise<ActionState> {
  await managers();
  const ok = await admin.resendNotificationEmail(s(f, "id"));
  return done(ok, ok ? "已重新排入寄送。" : "此通知不需要寄信或已寄出。");
}

// ---------- 班表（僅店長；先預覽再儲存） ----------

function scheduleResult(r: admin.ScheduleOutcome): ActionState {
  if (!r.ok) return { ok: false, message: r.message };
  if (r.phase === "preview") return { ok: true, message: r.affected.length ? `將有 ${r.affected.length} 筆未來預約受影響，確認後會標記為「需處理」，不會自動取消。` : "沒有預約受影響。", data: { phase: "preview", affected: r.affected } };
  refresh();
  return { ok: true, message: `已儲存。${r.changed ? `共 ${r.changed} 筆預約的衝突狀態已更新。` : ""}`, data: { phase: "saved" } };
}

export async function saveShiftAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  return scheduleResult(await admin.saveShift(me.user, f.get("commit") === "1", {
    id: s(f, "id") || undefined, doctorId: s(f, "doctorId"), weekday: Number(f.get("weekday")), start: s(f, "start"), end: s(f, "end"),
    effectiveFrom: s(f, "effectiveFrom") || "2000-01-01", effectiveTo: s(f, "effectiveTo") || null, active: true,
  }));
}

export async function removeShiftAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  return scheduleResult(await admin.removeShift(me.user, f.get("commit") === "1", s(f, "id")));
}

export async function saveDoctorAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  return scheduleResult(await admin.saveDoctor(me.user, f.get("commit") === "1", { id: s(f, "id") || undefined, displayName: s(f, "displayName"), active: f.get("active") !== "0" }));
}

export async function saveBlockAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const repeat = f.get("repeat") === "weekly";
  const scope = s(f, "scope") === "doctor" ? "doctor" : "clinic";
  return scheduleResult(await admin.saveBlock(me.user, f.get("commit") === "1", {
    weekday: repeat ? Number(f.get("weekday")) : null, specificDate: repeat ? null : s(f, "date") || null,
    start: s(f, "start"), end: s(f, "end"), scope, doctorId: scope === "doctor" ? s(f, "doctorId") || null : null, reason: s(f, "reason"),
  }));
}

export async function removeBlockAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  return scheduleResult(await admin.removeBlock(me.user, s(f, "id")));
}

export async function saveOpeningAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  return scheduleResult(await admin.saveOpening(me.user, f.get("commit") === "1", { weekdays: f.getAll("weekdays").map(Number), start: s(f, "start"), end: s(f, "end") }));
}

// ---------- 項目與設定 ----------

export async function itemAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const op = s(f, "op");
  const id = s(f, "id");
  const r =
    op === "add" ? await admin.addItem(me.user, s(f, "name")) :
    op === "rename" ? await admin.updateItem(me.user, id, { name: s(f, "name") }) :
    op === "toggle" ? await admin.updateItem(me.user, id, { active: f.get("active") === "1" }) :
    op === "up" ? await admin.updateItem(me.user, id, { move: -1 }) :
    op === "down" ? await admin.updateItem(me.user, id, { move: 1 }) :
    op === "delete" ? await admin.deleteItem(me.user, id) : { ok: false as const, message: "未知操作" };
  return done(r.ok, r.ok ? "已更新。" : r.message);
}

export async function settingsAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const events: NotifyEvent[] = ["sales_cancel", "sales_edit_within_4h", "deputy_action", "duplicate_phone", "sales_edit"];
  const notifyModes = Object.fromEntries(events.map((e) => [e, (s(f, `mode_${e}`) || "instant") as NotifyMode])) as Record<NotifyEvent, NotifyMode>;
  const r = await admin.saveSettings(me.user, {
    maxDays: Number(f.get("maxDays")),
    notifyEmails: s(f, "notifyEmails").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean),
    notifyModes,
  });
  return done(r.ok, r.ok ? "設定已儲存。" : r.message);
}

// ---------- 帳號 ----------

export async function createAccountAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const role = (["sales", "admin", "deputy"].includes(s(f, "role")) ? s(f, "role") : "sales") as Role;
  const r = await admin.createAccount(me.user, { displayName: s(f, "displayName"), loginName: s(f, "loginName"), role, password: s(f, "password") });
  return done(r.ok, r.ok ? "帳號已建立。" : r.message);
}

export async function toggleAccountAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const r = await admin.setAccountActive(me.user, s(f, "id"), f.get("active") === "1");
  if (!r.ok) return { ok: false, message: r.message, data: r.mustTransfer };
  return done(true, "已更新。");
}

export async function resetPasswordAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const r = await admin.resetPassword(me.user, s(f, "id"), s(f, "password"));
  return done(r.ok, r.ok ? "密碼已重設，該帳號需重新登入。" : r.message);
}

export async function transferAction(_p: ActionState, f: FormData): Promise<ActionState> {
  const me = await adminOnly();
  const r = await admin.transferFutureAppointments(me.user, s(f, "from"), s(f, "to"));
  return done(r.ok, r.ok ? `已轉出 ${r.count} 筆預約，現在可以停用帳號。` : r.message);
}

export async function goDate(f: FormData) {
  await managers();
  redirect(`/admin?date=${encodeURIComponent(s(f, "date"))}`);
}
