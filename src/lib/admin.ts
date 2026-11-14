import "server-only";
/** 設定中心與帳號管理（僅店長）。班表類異動一律「先預覽影響 → 確認後儲存 → 重算衝突」。 */
import { sql, withTx, type Q } from "@/lib/data/db";
import * as repo from "@/lib/data/repo";
import type { Ref } from "@/lib/data/repo";
import type { AuditLog, BlockRow, Doctor, DoctorShiftRow, NotifyEvent, NotifyMode, OpeningRow, Role, UserAccount } from "@/lib/data/types";
import { openingRulesFromDays, summarizeOpenings, validateOpeningDays, type OpeningDay, type ScheduleData } from "@/lib/domain/schedule";
import { hashPassword } from "@/lib/auth/password";
import { revokeSessions } from "@/lib/auth/session";
import { applyConflictRecompute, previewConflicts, scheduleData, todayTaipei } from "@/lib/booking";
import { scheduleEmailDelivery } from "@/lib/notify/deliver";

export type Affected = { id: string; label: string; reasons: string[] }[];
export type ScheduleOutcome =
  | { ok: true; phase: "preview"; affected: Affected }
  | { ok: true; phase: "saved"; changed: number }
  | { ok: false; message: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d: string) => DATE.test(d) && !Number.isNaN(Date.parse(d));

function log(q: Q, actor: UserAccount, entityType: Exclude<AuditLog["entityType"], "appointment">, entityId: string, action: string, changes: Record<string, unknown> = {}) {
  return repo.insertAudit(q, { entityType, entityId, actorUserId: actor.id, action, changes, reason: "" });
}

/** 一般設定類寫入：交易＋班表共用鎖 */
function settingsTx<T>(fn: (q: Q, ref: Ref) => Promise<T>): Promise<T> {
  return withTx(async (q) => {
    await repo.lockSchedule(q, "shared");
    return fn(q, await repo.loadRef(q));
  });
}

/**
 * 班表類異動的共用流程：
 * - preview：只用尚未儲存的新班表計算受影響預約，不寫入
 * - commit：取班表獨占鎖（此時沒有預約在寫入）→ 重新讀取並驗證 → 寫入 → 重算衝突，全部在同一交易
 */
/** 班表類異動的計畫：新班表（供預覽）、寫入方式、操作紀錄內容 */
interface SchedulePlan {
  next: ScheduleData;
  write: (q: Q) => Promise<void>;
  log: { entityType: "schedule" | "doctor"; entityId: string; action: string; changes: Record<string, unknown> };
}

async function scheduleChange(
  actor: UserAccount,
  commit: boolean,
  build: (ref: Ref) => SchedulePlan | { error: string },
): Promise<ScheduleOutcome> {
  if (!commit) {
    const q = sql();
    const ref = await repo.loadRef(q);
    const plan = build(ref);
    if ("error" in plan) return { ok: false, message: plan.error };
    const affected = await previewConflicts(q, ref, plan.next);
    return { ok: true, phase: "preview", affected: affected.map((c) => ({ id: c.id, label: c.label, reasons: c.reasons })) };
  }
  return withTx(async (q): Promise<ScheduleOutcome> => {
    await repo.lockSchedule(q, "exclusive");
    const plan = build(await repo.loadRef(q));
    if ("error" in plan) return { ok: false, message: plan.error };
    await plan.write(q);
    await log(q, actor, plan.log.entityType, plan.log.entityId, plan.log.action, plan.log.changes);
    return { ok: true, phase: "saved", changed: await applyConflictRecompute(q, await repo.loadRef(q), actor) };
  });
}

// ---------- 操作紀錄用的文字（記錄當下的名稱，之後改名也看得懂） ----------

const WEEKDAY = ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const doctorLabel = (ref: Ref, id: string | null) => ref.doctors.find((d) => d.id === id)?.displayName ?? "（已刪除醫師）";
const range = (from: string, to: string | null) => (to ? `${from}～${to}` : `${from} 起`);
const shiftText = (ref: Ref, x: Omit<DoctorShiftRow, "id">) => `${doctorLabel(ref, x.doctorId)} ${WEEKDAY[x.weekday]} ${x.start}–${x.end}（${range(x.effectiveFrom, x.effectiveTo)}）`;
const blockText = (ref: Ref, b: BlockRow) =>
  `${b.scope === "clinic" ? "全院封鎖" : `${doctorLabel(ref, b.doctorId)} 請假`} ${b.specificDate ?? `每${WEEKDAY[b.weekday ?? 0]}`} ${b.start}–${b.end}：${b.reason}`;

// ---------- 醫師與班表 ----------

export function saveShift(actor: UserAccount, commit: boolean, s: Omit<DoctorShiftRow, "id"> & { id?: string }): Promise<ScheduleOutcome> {
  if (!TIME.test(s.start) || !TIME.test(s.end) || s.end <= s.start) return Promise.resolve({ ok: false, message: "結束時間需晚於開始時間。" });
  if (!Number.isInteger(s.weekday) || s.weekday < 1 || s.weekday > 7) return Promise.resolve({ ok: false, message: "請選擇星期。" });
  if (!validDate(s.effectiveFrom) || (s.effectiveTo && !validDate(s.effectiveTo))) return Promise.resolve({ ok: false, message: "請填寫正確的日期。" });
  if (s.effectiveTo && s.effectiveTo < s.effectiveFrom) return Promise.resolve({ ok: false, message: "截止日不可早於生效日。" });
  const id = s.id ?? repo.newId();
  return scheduleChange(actor, commit, (ref) => {
    if (!ref.doctors.some((d) => d.id === s.doctorId)) return { error: "找不到醫師。" };
    if (s.id && !ref.shifts.some((x) => x.id === s.id)) return { error: "找不到班表。" };
    const row: DoctorShiftRow = { ...s, id };
    const before = s.id ? ref.shifts.find((x) => x.id === s.id) : undefined;
    const shifts = s.id ? ref.shifts.map((x) => (x.id === s.id ? row : x)) : [...ref.shifts, row];
    return {
      next: { ...scheduleData(ref), doctorShifts: shifts }, write: (q) => repo.upsertShift(q, row),
      log: {
        entityType: "schedule", entityId: id, action: before ? "shift-update" : "shift-create",
        changes: before ? { detail: { from: shiftText(ref, before), to: shiftText(ref, row) } } : { detail: shiftText(ref, row) },
      },
    };
  });
}

export function removeShift(actor: UserAccount, commit: boolean, id: string): Promise<ScheduleOutcome> {
  return scheduleChange(actor, commit, (ref) => {
    const before = ref.shifts.find((x) => x.id === id);
    if (!before) return { error: "找不到班表。" };
    return {
      next: { ...scheduleData(ref), doctorShifts: ref.shifts.filter((x) => x.id !== id) },
      write: (q) => repo.deleteShift(q, id),
      log: { entityType: "schedule", entityId: id, action: "shift-delete", changes: { detail: shiftText(ref, before) } },
    };
  });
}

export function saveDoctor(actor: UserAccount, commit: boolean, d: { id?: string; displayName: string; active: boolean }): Promise<ScheduleOutcome> {
  if (!d.displayName.trim()) return Promise.resolve({ ok: false, message: "請輸入醫師姓名。" });
  const id = d.id ?? repo.newId();
  return scheduleChange(actor, commit, (ref) => {
    if (d.id && !ref.doctors.some((x) => x.id === d.id)) return { error: "找不到醫師。" };
    const row: Doctor = { id, displayName: d.displayName.trim(), active: d.active };
    const before = d.id ? ref.doctors.find((x) => x.id === d.id) : undefined;
    const doctors = d.id ? ref.doctors.map((x) => (x.id === d.id ? row : x)) : [...ref.doctors, row];
    const changes: Record<string, unknown> = {};
    if (!before || before.displayName !== row.displayName) changes.displayName = before ? { from: before.displayName, to: row.displayName } : row.displayName;
    if (!before || before.active !== row.active) changes.active = before ? { from: before.active, to: row.active } : row.active;
    return {
      next: { ...scheduleData(ref), doctors }, write: (q) => repo.upsertDoctor(q, row),
      log: { entityType: "doctor", entityId: id, action: before ? "doctor-update" : "doctor-create", changes },
    };
  });
}

export function saveBlock(actor: UserAccount, commit: boolean, b: Omit<BlockRow, "id" | "effectiveFrom" | "effectiveTo" | "active">): Promise<ScheduleOutcome> {
  const bad = (message: string) => Promise.resolve<ScheduleOutcome>({ ok: false, message });
  if ((b.weekday === null) === (b.specificDate === null)) return bad("請指定日期或每週星期（擇一）。");
  if (b.specificDate !== null && !validDate(b.specificDate)) return bad("請填寫正確的日期。");
  if (b.weekday !== null && (!Number.isInteger(b.weekday) || b.weekday < 1 || b.weekday > 7)) return bad("請選擇星期。");
  if (!TIME.test(b.start) || !TIME.test(b.end) || b.end <= b.start) return bad("結束時間需晚於開始時間。");
  if (b.scope === "doctor" && !b.doctorId) return bad("請選擇請假的醫師。");
  if (b.scope === "clinic" && b.doctorId) return bad("全院封鎖不可指定醫師。");
  if (!b.reason.trim()) return bad("請填寫原因。");
  const row: BlockRow = { ...b, reason: b.reason.trim(), id: repo.newId(), effectiveFrom: todayTaipei(), effectiveTo: null, active: true };
  return scheduleChange(actor, commit, (ref) => {
    if (b.doctorId && !ref.doctors.some((d) => d.id === b.doctorId)) return { error: "找不到醫師。" };
    return {
      next: { ...scheduleData(ref), blocks: [...ref.blocks, row] }, write: (q) => repo.insertBlock(q, row),
      log: { entityType: "schedule", entityId: row.id, action: "block-create", changes: { detail: blockText(ref, row) } },
    };
  });
}

export function removeBlock(actor: UserAccount, id: string): Promise<ScheduleOutcome> {
  // 移除封鎖只會讓預約變得符合規則，不需預覽
  return scheduleChange(actor, true, (ref) => {
    const before = ref.blocks.find((x) => x.id === id);
    if (!before) return { error: "找不到封鎖或請假紀錄。" };
    return {
      next: scheduleData(ref), write: (q) => repo.deleteBlock(q, id),
      log: { entityType: "schedule", entityId: id, action: "block-delete", changes: { detail: blockText(ref, before) } },
    };
  });
}

/** 營業時間：每個星期各自設定（例如週一至週五 10–19、週六 10–17）；先預覽受影響預約再儲存 */
export function saveOpening(actor: UserAccount, commit: boolean, days: OpeningDay[]): Promise<ScheduleOutcome> {
  const bad = validateOpeningDays(days);
  if (bad) return Promise.resolve({ ok: false, message: bad });
  const rows: OpeningRow[] = openingRulesFromDays(days).map((r) => ({ ...r, id: repo.newId() }));
  return scheduleChange(actor, commit, (ref) => ({
    next: { ...scheduleData(ref), openings: rows },
    write: (q) => repo.replaceOpenings(q, rows),
    log: {
      entityType: "schedule", entityId: "opening", action: "opening-update",
      changes: { detail: ref.openings.length ? { from: summarizeOpenings(ref.openings), to: summarizeOpenings(rows) } : summarizeOpenings(rows) },
    },
  }));
}

// ---------- 預約項目 ----------

type Simple = { ok: true } | { ok: false; message: string };

export function addItem(actor: UserAccount, name: string): Promise<Simple> {
  return settingsTx(async (q, ref): Promise<Simple> => {
    if (!name.trim()) return { ok: false, message: "請輸入項目名稱。" };
    if (ref.items.some((i) => i.name === name.trim())) return { ok: false, message: "已有同名項目。" };
    const item = { id: repo.newId(), name: name.trim(), active: true, sortOrder: Math.max(0, ...ref.items.map((i) => i.sortOrder)) + 1 };
    await repo.insertItem(q, item);
    await log(q, actor, "item", item.id, "create", { name: item.name });
    return { ok: true };
  });
}

export function updateItem(actor: UserAccount, id: string, patch: { name?: string; active?: boolean; move?: -1 | 1 }): Promise<Simple> {
  return settingsTx(async (q, ref): Promise<Simple> => {
    const items = ref.items.map((x) => ({ ...x })).sort((a, b) => a.sortOrder - b.sortOrder);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, message: "找不到項目。" };
    const item = items[i];
    const before = { ...item };
    if (patch.name !== undefined) {
      if (!patch.name.trim()) return { ok: false, message: "名稱不可空白。" };
      if (items.some((x) => x.id !== id && x.name === patch.name!.trim())) return { ok: false, message: "已有同名項目。" };
      item.name = patch.name.trim();
    }
    if (patch.active !== undefined) item.active = patch.active;
    const touched = [item];
    if (patch.move) {
      const j = i + patch.move;
      if (j >= 0 && j < items.length) {
        [items[i].sortOrder, items[j].sortOrder] = [items[j].sortOrder, items[i].sortOrder];
        touched.push(items[j]);
      }
    }
    for (const t of touched) await repo.updateItemRow(q, t);
    const changes: Record<string, unknown> = { name: item.name };
    if (before.name !== item.name) changes.name = { from: before.name, to: item.name };
    if (before.active !== item.active) changes.active = { from: before.active, to: item.active };
    if (patch.move && touched.length > 1) changes.order = patch.move < 0 ? "往前移" : "往後移";
    await log(q, actor, "item", id, "update", changes);
    return { ok: true };
  });
}

export function deleteItem(actor: UserAccount, id: string): Promise<Simple> {
  return settingsTx(async (q, ref): Promise<Simple> => {
    const item = ref.items.find((i) => i.id === id);
    if (!item) return { ok: false, message: "找不到項目。" };
    if ((await repo.itemsInUse(q)).has(id)) return { ok: false, message: "此項目已被預約使用，只能停用不能刪除。" };
    await repo.deleteItemRow(q, id);
    await log(q, actor, "item", id, "delete", { name: item.name });
    return { ok: true };
  });
}

// ---------- 系統設定 ----------

export function saveSettings(actor: UserAccount, s: { maxDays: number; notifyEmails: string[]; notifyModes: Record<NotifyEvent, NotifyMode> }): Promise<Simple> {
  return settingsTx(async (q, ref): Promise<Simple> => {
    if (!Number.isInteger(s.maxDays) || s.maxDays < 1 || s.maxDays > 365) return { ok: false, message: "最遠可約天數需介於 1–365。" };
    const bad = s.notifyEmails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad) return { ok: false, message: `Email 格式不正確：${bad}` };
    const modes = Object.values(s.notifyModes);
    if (modes.some((m) => !["instant", "digest", "none"].includes(m))) return { ok: false, message: "通知方式不正確。" };
    await repo.saveSettingsRows(q, { ...ref.settings, ...s }, actor.id);
    const before = ref.settings;
    const changes: Record<string, unknown> = {};
    if (before.maxDays !== s.maxDays) changes.maxDays = { from: before.maxDays, to: s.maxDays };
    if (before.notifyEmails.join(",") !== s.notifyEmails.join(",")) changes.notifyEmails = { from: before.notifyEmails.join("、") || "（無）", to: s.notifyEmails.join("、") || "（無）" };
    for (const [event, mode] of Object.entries(s.notifyModes) as [NotifyEvent, NotifyMode][]) {
      if (before.notifyModes[event] !== mode) changes[`notifyMode.${event}`] = { from: before.notifyModes[event], to: mode };
    }
    await log(q, actor, "settings", "settings", "update", changes);
    return { ok: true };
  });
}

// ---------- 帳號 ----------

export function createAccount(actor: UserAccount, v: { displayName: string; loginName: string; role: Role; password: string }): Promise<Simple> {
  if (!v.displayName.trim() || !/^[a-zA-Z0-9._-]{3,30}$/.test(v.loginName)) return Promise.resolve({ ok: false, message: "請填寫顯示名稱；登入帳號需為 3–30 個英數字或 . _ -。" });
  if (v.password.length < 10) return Promise.resolve({ ok: false, message: "初始密碼至少 10 個字元。" });
  return settingsTx(async (q, ref): Promise<Simple> => {
    if (ref.users.some((u) => u.loginName.toLowerCase() === v.loginName.toLowerCase())) return { ok: false, message: "此登入帳號已存在。" };
    const user: UserAccount = {
      id: repo.newId(), loginName: v.loginName, passwordHash: hashPassword(v.password), displayName: v.displayName.trim(),
      role: v.role, active: v.role !== "deputy", createdAt: new Date().toISOString(),
    };
    await repo.insertUser(q, user);
    // 業務帳號必須綁一筆業務名單（規格 6）
    if (v.role === "sales") {
      await repo.insertSalesperson(q, {
        id: repo.newId(), displayName: user.displayName, active: true,
        sortOrder: Math.max(0, ...ref.salespeople.map((s) => s.sortOrder)) + 1, userAccountId: user.id,
      });
    }
    await log(q, actor, "account", user.id, "create", { name: user.displayName, loginName: user.loginName, role: user.role });
    return { ok: true };
  });
}

export type ToggleOutcome = { ok: true } | { ok: false; message: string; mustTransfer?: { salespersonId: string; count: number } };

export function setAccountActive(actor: UserAccount, id: string, active: boolean): Promise<ToggleOutcome> {
  return withTx(async (q): Promise<ToggleOutcome> => {
    // 獨占鎖：停用業務前確認名下沒有未來預約時，不會有人同時替他新增；也避免同時停用兩位店長
    await repo.lockSchedule(q, "exclusive");
    const ref = await repo.loadRef(q);
    const u = ref.users.find((x) => x.id === id);
    if (!u) return { ok: false, message: "找不到帳號。" };
    if (!active && u.role === "admin" && ref.users.filter((x) => x.role === "admin" && x.active).length <= 1) return { ok: false, message: "不能停用最後一位店長。" };
    const sp = ref.salespeople.find((s) => s.userAccountId === u.id);
    if (!active && u.role === "sales" && sp) {
      const future = (await repo.futureCountBySalesperson(q, todayTaipei())).get(sp.id) ?? 0;
      if (future > 0) return { ok: false, message: `${u.displayName} 名下還有 ${future} 筆未來預約，請先轉給其他業務。`, mustTransfer: { salespersonId: sp.id, count: future } };
    }
    if (u.role === "sales" && sp) await repo.setSalespersonActive(q, sp.id, active);
    await repo.setUserActive(q, u.id, active);
    if (!active) await revokeSessions(q, u.id); // 停用立即踢出
    await log(q, actor, "account", u.id, active ? "activate" : "deactivate", { name: u.displayName });
    return { ok: true };
  });
}

export function resetPassword(actor: UserAccount, id: string, password: string): Promise<Simple> {
  if (password.length < 10) return Promise.resolve({ ok: false, message: "新密碼至少 10 個字元。" });
  return withTx(async (q): Promise<Simple> => {
    const u = await repo.findUserById(q, id);
    if (!u) return { ok: false, message: "找不到帳號。" };
    await repo.setPasswordHash(q, u.id, hashPassword(password));
    await revokeSessions(q, u.id);
    await log(q, actor, "account", u.id, "reset-password", { name: u.displayName }); // 不記錄密碼或雜湊
    return { ok: true };
  });
}

/** 業務離職：一次把未來預約全部轉給另一位業務 */
export function transferFutureAppointments(actor: UserAccount, fromSalespersonId: string, toSalespersonId: string): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  return withTx(async (q) => {
    await repo.lockSchedule(q, "exclusive");
    const ref = await repo.loadRef(q);
    if (fromSalespersonId === toSalespersonId) return { ok: false as const, message: "請選擇另一位業務。" };
    if (!ref.salespeople.some((s) => s.id === fromSalespersonId)) return { ok: false as const, message: "找不到原業務。" };
    if (!ref.salespeople.some((s) => s.id === toSalespersonId && s.active)) return { ok: false as const, message: "請選擇啟用中的業務。" };
    const n = await repo.transferFuture(q, fromSalespersonId, toSalespersonId, todayTaipei(), actor.id);
    const spName = (sid: string) => ref.salespeople.find((x) => x.id === sid)?.displayName ?? "—";
    await log(q, actor, "salesperson", fromSalespersonId, "transfer", { salesperson: { from: spName(fromSalespersonId), to: spName(toSalespersonId) }, count: n });
    return { ok: true as const, count: n };
  });
}

// ---------- 後台頁面用讀取 ----------

export const listNotifications = (limit = 200) => repo.listNotifications(sql(), limit);
export const markAllNotificationsRead = () => repo.markAllNotificationsRead(sql());

export const listDigests = (limit = 14) => repo.listDigests(sql(), limit);

/** 日報重新排入寄送 */
export async function resendDigestEmail(id: string): Promise<boolean> {
  const ok = await repo.requeueDigest(sql(), id);
  if (ok) scheduleEmailDelivery();
  return ok;
}

/** 重新排入寄送，並在回應送出後立即嘗試 */
export async function resendNotificationEmail(id: string): Promise<boolean> {
  const ok = await repo.requeueEmail(sql(), id);
  if (ok) scheduleEmailDelivery();
  return ok;
}
export const itemsInUse = () => repo.itemsInUse(sql());
export const futureCountBySalesperson = () => repo.futureCountBySalesperson(sql(), todayTaipei());
