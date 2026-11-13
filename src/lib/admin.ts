import "server-only";
/** 設定中心與帳號管理（僅店長）。班表類異動一律「先預覽影響 → 確認後儲存 → 重算衝突」。 */
import { db, nextId } from "@/lib/data/store";
import type { BlockRow, DoctorShiftRow, NotifyEvent, NotifyMode, OpeningRow, Role, UserAccount } from "@/lib/data/types";
import type { ScheduleData } from "@/lib/domain/schedule";
import { hashPassword } from "@/lib/auth/password";
import { revokeSessions } from "@/lib/auth/session";
import { applyConflictRecompute, previewConflicts, scheduleData, todayTaipei } from "@/lib/booking";

export type Affected = { id: string; label: string; reasons: string[] }[];
export type ScheduleOutcome =
  | { ok: true; phase: "preview"; affected: Affected }
  | { ok: true; phase: "saved"; changed: number }
  | { ok: false; message: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function log(actor: UserAccount, entityType: "schedule" | "settings" | "account" | "item" | "doctor" | "salesperson", entityId: string, action: string, changes: Record<string, unknown> = {}) {
  db.audit.unshift({ id: nextId("log"), entityType, entityId, actorUserId: actor.id, action, changes, reason: "", createdAt: new Date().toISOString() });
}

/** 班表類異動的共用流程：preview 只計算，commit 才寫入並重算衝突 */
function scheduleChange(actor: UserAccount, commit: boolean, next: ScheduleData, write: () => void, what: string): ScheduleOutcome {
  if (!commit) {
    return { ok: true, phase: "preview", affected: previewConflicts(next).map((c) => ({ id: c.id, label: c.label, reasons: c.reasons })) };
  }
  write();
  log(actor, "schedule", what, "update");
  return { ok: true, phase: "saved", changed: applyConflictRecompute(actor) };
}

// ---------- 醫師與班表 ----------

export function saveShift(actor: UserAccount, commit: boolean, s: Omit<DoctorShiftRow, "id"> & { id?: string }): ScheduleOutcome {
  if (!TIME.test(s.start) || !TIME.test(s.end) || s.end <= s.start) return { ok: false, message: "結束時間需晚於開始時間。" };
  if (!db.doctors.some((d) => d.id === s.doctorId)) return { ok: false, message: "找不到醫師。" };
  if (s.weekday < 1 || s.weekday > 7) return { ok: false, message: "請選擇星期。" };
  if (s.effectiveTo && s.effectiveTo < s.effectiveFrom) return { ok: false, message: "截止日不可早於生效日。" };
  const row: DoctorShiftRow = { ...s, id: s.id ?? nextId("shift") };
  const shifts = s.id ? db.shifts.map((x) => (x.id === s.id ? row : x)) : [...db.shifts, row];
  return scheduleChange(actor, commit, { ...scheduleData(), doctorShifts: shifts }, () => { db.shifts = shifts; }, row.id);
}

export function removeShift(actor: UserAccount, commit: boolean, id: string): ScheduleOutcome {
  const shifts = db.shifts.filter((x) => x.id !== id);
  return scheduleChange(actor, commit, { ...scheduleData(), doctorShifts: shifts }, () => { db.shifts = shifts; }, id);
}

export function saveDoctor(actor: UserAccount, commit: boolean, d: { id?: string; displayName: string; active: boolean }): ScheduleOutcome {
  if (!d.displayName.trim()) return { ok: false, message: "請輸入醫師姓名。" };
  const doctors = d.id
    ? db.doctors.map((x) => (x.id === d.id ? { ...x, displayName: d.displayName.trim(), active: d.active } : x))
    : [...db.doctors, { id: nextId("doc"), displayName: d.displayName.trim(), active: d.active }];
  return scheduleChange(actor, commit, { ...scheduleData(), doctors }, () => { db.doctors = doctors; }, d.id ?? "new-doctor");
}

export function saveBlock(actor: UserAccount, commit: boolean, b: Omit<BlockRow, "id" | "effectiveFrom" | "effectiveTo" | "active">): ScheduleOutcome {
  if ((b.weekday === null) === (b.specificDate === null)) return { ok: false, message: "請指定日期或每週星期（擇一）。" };
  if (!TIME.test(b.start) || !TIME.test(b.end) || b.end <= b.start) return { ok: false, message: "結束時間需晚於開始時間。" };
  if (b.scope === "doctor" && !b.doctorId) return { ok: false, message: "請選擇請假的醫師。" };
  if (b.scope === "clinic" && b.doctorId) return { ok: false, message: "全院封鎖不可指定醫師。" };
  if (!b.reason.trim()) return { ok: false, message: "請填寫原因。" };
  const row: BlockRow = { ...b, reason: b.reason.trim(), id: nextId("block"), effectiveFrom: todayTaipei(), effectiveTo: null, active: true };
  const blocks = [...db.blocks, row];
  return scheduleChange(actor, commit, { ...scheduleData(), blocks }, () => { db.blocks = blocks; }, row.id);
}

export function removeBlock(actor: UserAccount, id: string): ScheduleOutcome {
  // 移除封鎖只會讓預約變得符合規則，不需預覽
  return scheduleChange(actor, true, scheduleData(), () => { db.blocks = db.blocks.filter((x) => x.id !== id); }, id);
}

export function saveOpening(actor: UserAccount, commit: boolean, o: { weekdays: number[]; start: string; end: string }): ScheduleOutcome {
  if (!TIME.test(o.start) || !TIME.test(o.end) || o.end <= o.start) return { ok: false, message: "結束時間需晚於開始時間。" };
  if (o.start.slice(3) !== "00" || o.end.slice(3) !== "00") return { ok: false, message: "營業時間請設定為整點。" };
  const openings: OpeningRow[] = [{ id: db.openings[0]?.id ?? nextId("open"), weekdays: [...new Set(o.weekdays)].sort(), start: o.start, end: o.end, effectiveFrom: "2000-01-01", effectiveTo: null }];
  return scheduleChange(actor, commit, { ...scheduleData(), openings }, () => { db.openings = openings; }, "opening");
}

// ---------- 預約項目 ----------

export function addItem(actor: UserAccount, name: string) {
  if (!name.trim()) return { ok: false as const, message: "請輸入項目名稱。" };
  if (db.items.some((i) => i.name === name.trim())) return { ok: false as const, message: "已有同名項目。" };
  const item = { id: nextId("item"), name: name.trim(), active: true, sortOrder: Math.max(0, ...db.items.map((i) => i.sortOrder)) + 1 };
  db.items.push(item);
  log(actor, "item", item.id, "create", { name: item.name });
  return { ok: true as const };
}

export function updateItem(actor: UserAccount, id: string, patch: { name?: string; active?: boolean; move?: -1 | 1 }) {
  const items = [...db.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false as const, message: "找不到項目。" };
  const item = items[i];
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false as const, message: "名稱不可空白。" };
    item.name = patch.name.trim();
  }
  if (patch.active !== undefined) item.active = patch.active;
  if (patch.move) {
    const j = i + patch.move;
    if (j >= 0 && j < items.length) [items[i].sortOrder, items[j].sortOrder] = [items[j].sortOrder, items[i].sortOrder];
  }
  log(actor, "item", id, "update", patch);
  return { ok: true as const };
}

export function deleteItem(actor: UserAccount, id: string) {
  if (db.appointments.some((a) => a.itemId === id)) return { ok: false as const, message: "此項目已被預約使用，只能停用不能刪除。" };
  db.items = db.items.filter((i) => i.id !== id);
  log(actor, "item", id, "delete");
  return { ok: true as const };
}

// ---------- 系統設定 ----------

export function saveSettings(actor: UserAccount, s: { maxDays: number; notifyEmails: string[]; notifyModes: Record<NotifyEvent, NotifyMode> }) {
  if (!Number.isInteger(s.maxDays) || s.maxDays < 1 || s.maxDays > 365) return { ok: false as const, message: "最遠可約天數需介於 1–365。" };
  const bad = s.notifyEmails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad) return { ok: false as const, message: `Email 格式不正確：${bad}` };
  db.settings = { ...db.settings, ...s };
  log(actor, "settings", "settings", "update", { maxDays: s.maxDays, notifyEmails: s.notifyEmails.length, notifyModes: s.notifyModes });
  return { ok: true as const };
}

// ---------- 帳號 ----------

function activeAdmins() {
  return db.users.filter((u) => u.role === "admin" && u.active);
}

export function createAccount(actor: UserAccount, v: { displayName: string; loginName: string; role: Role; password: string }) {
  if (!v.displayName.trim() || !/^[a-zA-Z0-9._-]{3,30}$/.test(v.loginName)) return { ok: false as const, message: "請填寫顯示名稱；登入帳號需為 3–30 個英數字或 . _ -。" };
  if (db.users.some((u) => u.loginName.toLowerCase() === v.loginName.toLowerCase())) return { ok: false as const, message: "此登入帳號已存在。" };
  if (v.password.length < 10) return { ok: false as const, message: "初始密碼至少 10 個字元。" };
  const user: UserAccount = {
    id: nextId("u"), loginName: v.loginName, passwordHash: hashPassword(v.password), displayName: v.displayName.trim(),
    role: v.role, active: v.role !== "deputy", createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  // 業務帳號必須綁一筆業務名單（規格 6）
  if (v.role === "sales") {
    db.salespeople.push({ id: nextId("sp"), displayName: user.displayName, active: true, sortOrder: db.salespeople.length + 1, userAccountId: user.id });
  }
  log(actor, "account", user.id, "create", { loginName: user.loginName, role: user.role });
  return { ok: true as const };
}

export type ToggleOutcome = { ok: true } | { ok: false; message: string; mustTransfer?: { salespersonId: string; count: number } };

export function setAccountActive(actor: UserAccount, id: string, active: boolean): ToggleOutcome {
  const u = db.users.find((x) => x.id === id);
  if (!u) return { ok: false, message: "找不到帳號。" };
  if (!active && u.role === "admin" && activeAdmins().length <= 1) return { ok: false, message: "不能停用最後一位店長。" };
  if (!active && u.role === "sales") {
    const sp = db.salespeople.find((s) => s.userAccountId === u.id);
    const future = sp ? db.appointments.filter((a) => a.salespersonId === sp.id && a.status === "active" && a.date >= todayTaipei()).length : 0;
    if (sp && future > 0) return { ok: false, message: `${u.displayName} 名下還有 ${future} 筆未來預約，請先轉給其他業務。`, mustTransfer: { salespersonId: sp.id, count: future } };
    if (sp) sp.active = false;
  }
  if (active && u.role === "sales") {
    const sp = db.salespeople.find((s) => s.userAccountId === u.id);
    if (sp) sp.active = true;
  }
  u.active = active;
  if (!active) revokeSessions(u.id); // 停用立即踢出
  log(actor, "account", u.id, active ? "activate" : "deactivate");
  return { ok: true };
}

export function resetPassword(actor: UserAccount, id: string, password: string) {
  const u = db.users.find((x) => x.id === id);
  if (!u) return { ok: false as const, message: "找不到帳號。" };
  if (password.length < 10) return { ok: false as const, message: "新密碼至少 10 個字元。" };
  u.passwordHash = hashPassword(password);
  revokeSessions(u.id);
  log(actor, "account", u.id, "reset-password"); // 不記錄密碼或雜湊
  return { ok: true as const };
}

/** 業務離職：一次把未來預約全部轉給另一位業務 */
export function transferFutureAppointments(actor: UserAccount, fromSalespersonId: string, toSalespersonId: string) {
  if (fromSalespersonId === toSalespersonId) return { ok: false as const, message: "請選擇另一位業務。" };
  if (!db.salespeople.some((s) => s.id === toSalespersonId && s.active)) return { ok: false as const, message: "請選擇啟用中的業務。" };
  const today = todayTaipei();
  let n = 0;
  for (const a of db.appointments) {
    if (a.salespersonId === fromSalespersonId && a.status === "active" && a.date >= today) {
      a.salespersonId = toSalespersonId;
      a.version += 1;
      n++;
    }
  }
  log(actor, "salesperson", fromSalespersonId, "transfer", { to: toSalespersonId, count: n });
  return { ok: true as const, count: n };
}
