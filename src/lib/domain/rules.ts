/**
 * 業務的時間與欄位規則（規格 5.3）。
 * 純函式：不碰資料庫。容量（空不空）與班表是否符合由 slots.ts / 交易內另行檢查。
 * 店長與代理店長不套用這些規則。
 */
import { addDays, minutesUntil, toTaipei } from "./time";

export const CREATE_LEAD_MIN = 60;
export const EDIT_LEAD_MIN = 240;

export type AppointmentStatus = "active" | "completed" | "no_show" | "cancelled";
/** 占用時段的狀態（取消不占用）。資料庫查詢占用時段也必須用這份清單 */
export const OCCUPYING_STATUSES: readonly AppointmentStatus[] = ["active", "completed", "no_show"];

export type ConflictStatus = "none" | "conflict" | "kept";

export type RuleReason =
  | "LEAD_TIME"
  | "TOO_FAR"
  | "NOT_ON_HOUR"
  | "WITHIN_4H"
  | "STARTED"
  | "NOT_ACTIVE"
  | "FORBIDDEN_FIELD"
  | "NO_CHANGES";

export type RuleResult = { ok: true } | { ok: false; reason: RuleReason };

export function checkSalesCreate(input: { now: Date; date: string; start: string; maxDays: number }): RuleResult {
  const { now, date, start, maxDays } = input;
  if (!/^\d{2}:00$/.test(start)) return { ok: false, reason: "NOT_ON_HOUR" };
  if (minutesUntil(now, date, start) < CREATE_LEAD_MIN) return { ok: false, reason: "LEAD_TIME" };
  if (date > addDays(toTaipei(now).date, maxDays)) return { ok: false, reason: "TOO_FAR" };
  return { ok: true };
}

export interface ExistingAppointment {
  date: string;
  start: string;
  status: AppointmentStatus;
  conflictStatus: ConflictStatus;
}

export interface SalesChanges {
  time?: { date: string; start: string };
  itemIds?: string[];
  requiresDoctor?: boolean;
  cancel?: true;
  salespersonId?: string;
  customerName?: string;
  phone?: string;
  careNote?: string;
  preferredDoctorNote?: string;
  partySize?: number;
}

export type EditResult = { ok: true; notifyWithin4h: boolean } | { ok: false; reason: RuleReason };

export function checkSalesEdit(input: {
  now: Date;
  maxDays: number;
  appointment: ExistingAppointment;
  changes: SalesChanges;
}): EditResult {
  const { now, maxDays, appointment: a, changes: c } = input;
  const defined = (Object.keys(c) as (keyof SalesChanges)[]).filter((k) => c[k] !== undefined);

  if (defined.length === 0) return { ok: false, reason: "NO_CHANGES" };
  if (c.salespersonId !== undefined) return { ok: false, reason: "FORBIDDEN_FIELD" };
  if (a.status !== "active") return { ok: false, reason: "NOT_ACTIVE" };

  const left = minutesUntil(now, a.date, a.start);
  if (left <= 0) return { ok: false, reason: "STARTED" };

  const within4h = left < EDIT_LEAD_MIN;
  const inConflict = a.conflictStatus === "conflict";

  // 受 4 小時限制的變更；衝突預約可豁免改期、取消、改成僅護理師
  const restricted: boolean[] = [
    c.time !== undefined && !inConflict,
    c.cancel !== undefined && !inConflict,
    c.itemIds !== undefined,
    c.requiresDoctor !== undefined && !(inConflict && c.requiresDoctor === false),
  ];
  if (within4h && restricted.some(Boolean)) return { ok: false, reason: "WITHIN_4H" };

  if (c.time) {
    const r = checkSalesCreate({ now, date: c.time.date, start: c.time.start, maxDays });
    if (!r.ok) return r;
  }

  const basicFields: (keyof SalesChanges)[] = ["customerName", "phone", "careNote", "preferredDoctorNote", "partySize"];
  const touchesBasic = basicFields.some((k) => c[k] !== undefined);
  return { ok: true, notifyWithin4h: within4h && touchesBasic };
}

// ---------- 預約項目（可複選，2026-11-14 決策） ----------

/** 一筆預約最多選幾個項目 */
export const MAX_ITEMS = 5;

export type ItemSelection = { ok: true; itemIds: string[] } | { ok: false; reason: "ITEM_REQUIRED" | "ITEM_TOO_MANY" | "ITEM_INVALID" };

/**
 * 檢查選擇的項目：去除空白與重複（保留順序），至少 1 項、最多 MAX_ITEMS 項，
 * 每項都必須是啟用中的項目；原本就在這筆預約上的項目即使已停用也可保留。
 */
export function checkItemSelection(input: { selected: string[]; activeIds: string[]; alreadyOnAppointment?: string[] }): ItemSelection {
  const ids = [...new Set(input.selected.map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, reason: "ITEM_REQUIRED" };
  if (ids.length > MAX_ITEMS) return { ok: false, reason: "ITEM_TOO_MANY" };
  const allowed = new Set([...input.activeIds, ...(input.alreadyOnAppointment ?? [])]);
  if (ids.some((id) => !allowed.has(id))) return { ok: false, reason: "ITEM_INVALID" };
  return { ok: true, itemIds: ids };
}

/** 兩組項目是否相同（不計順序） */
export function sameItems(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}
