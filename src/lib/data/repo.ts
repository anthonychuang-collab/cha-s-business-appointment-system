import "server-only";
/**
 * 資料庫存取層：只負責 SQL 與欄位對應，不放任何預約規則（規則在 lib/domain）。
 * 每個函式第一個參數是 Q：一般連線或交易內連線（withTx 給的 tx）。
 */
import { randomUUID } from "node:crypto";
import type { Q } from "./db";
import type {
  Appointment, AuditLog, BlockRow, Doctor, DoctorShiftRow, Item, Notification, NotifyEvent, NotifyMode, OpeningRow,
  Salesperson, Settings, UserAccount,
} from "./types";
import type { ConflictReason } from "@/lib/domain/conflicts";
import { OCCUPYING_STATUSES } from "@/lib/domain/rules";

export const newId = (): string => randomUUID();

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const hm = (v: unknown): string => String(v).slice(0, 5); // time "13:00:00" → "13:00"

// ---------- 鎖（交易內使用；交易結束自動釋放，適用 Supabase transaction pooler） ----------
//
// 取鎖順序固定，避免死結：班表鎖 → 冪等鍵 → 預約列（FOR UPDATE）→ 時段鎖 → 編號鎖。

/** 預約類寫入取共用鎖；班表／營業時間異動與批次轉移取獨占鎖（讓重算衝突時沒有預約在寫入） */
export async function lockSchedule(tx: Q, mode: "shared" | "exclusive"): Promise<void> {
  if (mode === "shared") await tx`select pg_advisory_xact_lock_shared(0, 0)`;
  else await tx`select pg_advisory_xact_lock(0, 0)`;
}

/** 同一時段（日期＋開始時間）的鎖：讀取占用狀況前取得（規格：pg_advisory_xact_lock(hashtext(date || start))） */
export async function lockSlot(tx: Q, date: string, start: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${date + start}))`;
}

/** 其他命名鎖（冪等鍵、每日預約編號） */
export async function lockKey(tx: Q, key: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(1, hashtext(${key}))`;
}

// ---------- 設定類資料（量小，整批讀） ----------

export interface Ref {
  users: UserAccount[];
  salespeople: Salesperson[];
  items: Item[];
  doctors: Doctor[];
  shifts: DoctorShiftRow[];
  blocks: BlockRow[];
  openings: OpeningRow[];
  settings: Settings;
}

const DEFAULT_MODES: Record<NotifyEvent, NotifyMode> = {
  sales_cancel: "instant", sales_edit_within_4h: "instant", deputy_action: "instant", duplicate_phone: "instant", sales_edit: "digest",
};

const mapUser = (r: Row): UserAccount => ({
  id: String(r.id), loginName: String(r.login_name), passwordHash: String(r.password_hash), displayName: String(r.display_name),
  role: r.role as UserAccount["role"], active: Boolean(r.active), createdAt: iso(r.created_at),
});
const mapSalesperson = (r: Row): Salesperson => ({
  id: String(r.id), displayName: String(r.display_name), active: Boolean(r.active), sortOrder: Number(r.sort_order),
  userAccountId: r.user_account_id == null ? null : String(r.user_account_id),
});

export async function loadRef(q: Q): Promise<Ref> {
  const [users, salespeople, items, doctors, shifts, blocks, openings, settings] = await Promise.all([
    q`select * from user_accounts order by created_at, login_name`,
    q`select * from salespeople order by sort_order, created_at`,
    q`select * from appointment_items order by sort_order, created_at`,
    q`select * from doctors order by created_at, display_name`,
    q`select * from doctor_shifts order by weekday, start_time`,
    q`select * from schedule_blocks order by created_at`,
    q`select * from opening_rules order by created_at`,
    q`select key, value from system_settings`,
  ]);
  const kv = new Map(settings.map((r) => [String(r.key), r.value as unknown]));
  return {
    users: users.map(mapUser),
    salespeople: salespeople.map(mapSalesperson),
    items: items.map((r) => ({ id: String(r.id), name: String(r.name), active: Boolean(r.active), sortOrder: Number(r.sort_order) })),
    doctors: doctors.map((r) => ({ id: String(r.id), displayName: String(r.display_name), active: Boolean(r.active) })),
    shifts: shifts.map((r) => ({
      id: String(r.id), doctorId: String(r.doctor_id), weekday: Number(r.weekday), start: hm(r.start_time), end: hm(r.end_time),
      effectiveFrom: String(r.effective_from), effectiveTo: (r.effective_to as string | null) ?? null, active: Boolean(r.active),
    })),
    blocks: blocks.map((r) => ({
      id: String(r.id), weekday: r.weekday == null ? null : Number(r.weekday), specificDate: (r.specific_date as string | null) ?? null,
      start: hm(r.start_time), end: hm(r.end_time), scope: r.scope as BlockRow["scope"], doctorId: r.doctor_id == null ? null : String(r.doctor_id),
      effectiveFrom: String(r.effective_from), effectiveTo: (r.effective_to as string | null) ?? null, reason: String(r.reason), active: Boolean(r.active),
    })),
    openings: openings.map((r) => ({
      id: String(r.id), weekdays: (r.weekdays as number[]).map(Number), start: hm(r.start_time), end: hm(r.end_time),
      effectiveFrom: String(r.effective_from), effectiveTo: (r.effective_to as string | null) ?? null,
    })),
    settings: {
      maxDays: Number(kv.get("max_days") ?? 60),
      notifyEmails: (kv.get("notify_emails") as string[] | undefined) ?? [],
      notifyModes: { ...DEFAULT_MODES, ...((kv.get("notify_modes") as Partial<Record<NotifyEvent, NotifyMode>> | undefined) ?? {}) },
    },
  };
}

// ---------- 預約 ----------

const mapAppointment = (r: Row): Appointment => ({
  id: String(r.id), code: String(r.code), customerName: String(r.customer_name), phone: String(r.phone), phoneNormalized: String(r.phone_normalized),
  date: String(r.appointment_date), start: hm(r.start_time), end: hm(r.end_time), itemId: String(r.item_id), partySize: Number(r.party_size),
  requiresDoctor: Boolean(r.requires_doctor), assignedDoctorId: r.assigned_doctor_id == null ? null : String(r.assigned_doctor_id),
  preferredDoctorNote: String(r.preferred_doctor_note), careNote: String(r.care_note), salespersonId: String(r.salesperson_id),
  status: r.status as Appointment["status"], isOverbooked: Boolean(r.is_overbooked), overbookReason: String(r.overbook_reason),
  conflictStatus: r.conflict_status as Appointment["conflictStatus"], conflictReasons: r.conflict_reasons as ConflictReason[],
  conflictKeptReasons: r.conflict_kept_reasons as ConflictReason[], conflictKeptNote: String(r.conflict_kept_note),
  createdBy: String(r.created_by), updatedBy: String(r.updated_by), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  cancelledAt: isoOrNull(r.cancelled_at), version: Number(r.version),
});

function appointmentColumns(a: Appointment) {
  return {
    code: a.code, customer_name: a.customerName, phone: a.phone, phone_normalized: a.phoneNormalized,
    appointment_date: a.date, start_time: a.start, end_time: a.end, item_id: a.itemId, party_size: a.partySize,
    requires_doctor: a.requiresDoctor, assigned_doctor_id: a.assignedDoctorId, preferred_doctor_note: a.preferredDoctorNote,
    care_note: a.careNote, salesperson_id: a.salespersonId, status: a.status, is_overbooked: a.isOverbooked,
    overbook_reason: a.overbookReason, conflict_status: a.conflictStatus, conflict_reasons: a.conflictReasons,
    conflict_kept_reasons: a.conflictKeptReasons, conflict_kept_note: a.conflictKeptNote, updated_by: a.updatedBy,
    updated_at: new Date(a.updatedAt), cancelled_at: a.cancelledAt ? new Date(a.cancelledAt) : null, version: a.version,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (id: string): boolean => UUID.test(id);

/** forUpdate：交易內鎖住該列，避免兩人同時修改 */
export async function findAppointment(q: Q, id: string, forUpdate = false): Promise<Appointment | null> {
  if (!isUuid(id)) return null;
  const rows = forUpdate
    ? await q`select * from appointments where id = ${id} for update`
    : await q`select * from appointments where id = ${id}`;
  return rows[0] ? mapAppointment(rows[0]) : null;
}

export interface AppointmentFilter {
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  start?: string;
  salespersonId?: string;
  status?: Appointment["status"];
  conflictStatus?: Appointment["conflictStatus"];
  phoneNormalized?: string;
  excludeId?: string;
  limit?: number;
}

export async function listAppointments(q: Q, f: AppointmentFilter): Promise<Appointment[]> {
  const conds = [q`true`];
  if (f.date) conds.push(q`appointment_date = ${f.date}`);
  if (f.dateFrom) conds.push(q`appointment_date >= ${f.dateFrom}`);
  if (f.dateTo) conds.push(q`appointment_date <= ${f.dateTo}`);
  if (f.start) conds.push(q`start_time = ${f.start}`);
  if (f.salespersonId) conds.push(isUuid(f.salespersonId) ? q`salesperson_id = ${f.salespersonId}` : q`false`);
  if (f.status) conds.push(q`status = ${f.status}`);
  if (f.conflictStatus) conds.push(q`conflict_status = ${f.conflictStatus}`);
  if (f.phoneNormalized) conds.push(q`phone_normalized = ${f.phoneNormalized}`);
  if (f.excludeId && isUuid(f.excludeId)) conds.push(q`id <> ${f.excludeId}`);
  const where = conds.reduce((acc, c) => q`${acc} and ${c}`);
  const rows = f.limit
    ? await q`select * from appointments where ${where} order by appointment_date, start_time, created_at limit ${f.limit}`
    : await q`select * from appointments where ${where} order by appointment_date, start_time, created_at`;
  return rows.map(mapAppointment);
}

/** 期間內每天被占用的開始時間（取消不占用） */
export async function occupiedByDate(q: Q, from: string, to: string, excludeId?: string): Promise<Map<string, string[]>> {
  const ex = excludeId && isUuid(excludeId) ? excludeId : null;
  const rows = await q`
    select appointment_date, start_time from appointments
    where appointment_date between ${from} and ${to}
      and status = any(${[...OCCUPYING_STATUSES]})
      and (${ex}::uuid is null or id <> ${ex}::uuid)`;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const d = String(r.appointment_date);
    out.set(d, [...(out.get(d) ?? []), hm(r.start_time)]);
  }
  return out;
}

export async function countAppointmentsOnDate(q: Q, date: string): Promise<number> {
  const [r] = await q`select count(*)::int as n from appointments where appointment_date = ${date}`;
  return Number(r.n);
}

export async function insertAppointment(q: Q, a: Appointment): Promise<void> {
  const cols = { id: a.id, ...appointmentColumns(a), created_by: a.createdBy, created_at: new Date(a.createdAt) };
  await q`insert into appointments ${q(cols)}`;
}

/** 以版本號寫回整筆預約；被別人搶先改過則回傳 false */
export async function saveAppointment(q: Q, a: Appointment, expectedVersion: number): Promise<boolean> {
  const rows = await q`update appointments set ${q(appointmentColumns(a))} where id = ${a.id} and version = ${expectedVersion} returning id`;
  return rows.length === 1;
}

export async function itemsInUse(q: Q): Promise<Set<string>> {
  const rows = await q`select distinct item_id from appointments`;
  return new Set(rows.map((r) => String(r.item_id)));
}

export async function futureCountBySalesperson(q: Q, today: string): Promise<Map<string, number>> {
  const rows = await q`
    select salesperson_id, count(*)::int as n from appointments
    where status = 'active' and appointment_date >= ${today} group by salesperson_id`;
  return new Map(rows.map((r) => [String(r.salesperson_id), Number(r.n)]));
}

/** 業務離職：一次轉出未來預約，回傳筆數 */
export async function transferFuture(q: Q, from: string, to: string, today: string, actorId: string): Promise<number> {
  const rows = await q`
    update appointments set salesperson_id = ${to}, version = version + 1, updated_by = ${actorId}, updated_at = now()
    where salesperson_id = ${from} and status = 'active' and appointment_date >= ${today}
    returning id`;
  return rows.length;
}

// ---------- 冪等 ----------

export async function findIdempotent(q: Q, key: string): Promise<string | null> {
  const [r] = await q`select appointment_id from idempotency_keys where key = ${key}`;
  return r ? String(r.appointment_id) : null;
}

export async function saveIdempotent(q: Q, key: string, appointmentId: string): Promise<void> {
  await q`insert into idempotency_keys (key, appointment_id) values (${key}, ${appointmentId})`;
}

// ---------- 通知與稽核 ----------

/** 即時信的通知寫入後立刻排入寄送（email_next_attempt_at = now()） */
export async function insertNotification(
  q: Q, n: Pick<Notification, "event" | "appointmentId" | "actorUserId" | "summary" | "mode" | "payload">,
): Promise<void> {
  await q`
    insert into notifications (event_type, appointment_id, actor_user_id, summary, email_mode, payload, email_next_attempt_at)
    values (${n.event}, ${n.appointmentId}, ${n.actorUserId}, ${n.summary}, ${n.mode}, ${q.json(n.payload as never)},
      ${n.mode === "instant" ? q`now()` : null})`;
}

const mapNotification = (r: Row): Notification => ({
  id: String(r.id), event: r.event_type as NotifyEvent, appointmentId: r.appointment_id == null ? null : String(r.appointment_id),
  actorUserId: String(r.actor_user_id), summary: String(r.summary), mode: r.email_mode as NotifyMode,
  readAt: isoOrNull(r.read_at), createdAt: iso(r.created_at), payload: (r.payload as Record<string, unknown>) ?? {},
  emailSentAt: isoOrNull(r.email_sent_at), emailError: (r.email_error as string | null) ?? null,
  emailAttempts: Number(r.email_attempts ?? 0), emailNextAttemptAt: isoOrNull(r.email_next_attempt_at),
  digestId: r.digest_id == null ? null : String(r.digest_id),
});

export async function listNotifications(q: Q, limit: number): Promise<Notification[]> {
  const rows = await q`select * from notifications order by created_at desc limit ${limit}`;
  return rows.map(mapNotification);
}

/** 重試間隔（分鐘），依第幾次嘗試；最後一個值之後沿用 */
export const EMAIL_BACKOFF_MIN = [1, 5, 30, 120, 720];

/**
 * 取出到期要寄的即時信，同時把下一次嘗試時間往後推（租約）並把嘗試次數 +1。
 * SKIP LOCKED：多個程序同時寄送時各拿不同的信，不會重複寄。
 */
export async function claimDueEmails(q: Q, limit: number): Promise<Notification[]> {
  const rows = await q`
    with due as (
      select id from notifications
      where email_mode = 'instant' and email_sent_at is null and email_next_attempt_at <= now()
      order by email_next_attempt_at, created_at
      limit ${limit}
      for update skip locked
    )
    update notifications n set
      email_attempts = n.email_attempts + 1,
      email_next_attempt_at = now() + make_interval(mins => (${EMAIL_BACKOFF_MIN}::int[])[least(n.email_attempts + 1, ${EMAIL_BACKOFF_MIN.length})])
    from due where n.id = due.id
    returning n.*`;
  return rows.map(mapNotification);
}

export async function markEmailSent(q: Q, id: string, messageId: string): Promise<void> {
  await q`update notifications set email_sent_at = now(), email_next_attempt_at = null, email_error = null, email_message_id = ${messageId} where id = ${id}`;
}

/** stop = true：不再重試（設定錯誤或已達次數上限）；否則保留租約時間，到期再試 */
export async function markEmailFailed(q: Q, id: string, error: string, stop: boolean): Promise<void> {
  if (stop) await q`update notifications set email_error = ${error}, email_next_attempt_at = null where id = ${id}`;
  else await q`update notifications set email_error = ${error} where id = ${id}`;
}

/** 店長手動重寄（例如補上收件地址或修好寄件網域後）；回傳是否有排入 */
export async function requeueEmail(q: Q, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await q`
    update notifications set email_next_attempt_at = now(), email_attempts = 0
    where id = ${id} and email_mode = 'instant' and email_sent_at is null
    returning id`;
  return rows.length === 1;
}

export async function findUserNames(q: Q, ids: string[]): Promise<Map<string, string>> {
  const valid = [...new Set(ids)].filter(isUuid);
  if (!valid.length) return new Map();
  const rows = await q`select id, display_name from user_accounts where id = any(${valid}::uuid[])`;
  return new Map(rows.map((r) => [String(r.id), String(r.display_name)]));
}

export async function unreadNotificationCount(q: Q): Promise<number> {
  const [r] = await q`select count(*)::int as n from notifications where read_at is null`;
  return Number(r.n);
}

export async function markAllNotificationsRead(q: Q): Promise<void> {
  await q`update notifications set read_at = now() where read_at is null`;
}

export async function insertAudit(q: Q, l: Omit<AuditLog, "id" | "createdAt">): Promise<void> {
  await q`
    insert into audit_logs (entity_type, entity_id, actor_user_id, action, changes, reason)
    values (${l.entityType}, ${l.entityId}, ${l.actorUserId}, ${l.action}, ${q.json(l.changes as never)}, ${l.reason})`;
}

export async function listAudit(q: Q, entityType: AuditLog["entityType"], entityId: string): Promise<AuditLog[]> {
  const rows = await q`select * from audit_logs where entity_type = ${entityType} and entity_id = ${entityId} order by created_at desc`;
  return rows.map((r) => ({
    id: String(r.id), entityType: r.entity_type as AuditLog["entityType"], entityId: String(r.entity_id),
    actorUserId: r.actor_user_id == null ? "" : String(r.actor_user_id), action: String(r.action),
    changes: (r.changes as Record<string, unknown>) ?? {}, reason: String(r.reason), createdAt: iso(r.created_at),
  }));
}

// ---------- 醫師、班表、營業時間 ----------

export async function upsertShift(q: Q, s: DoctorShiftRow): Promise<void> {
  await q`
    insert into doctor_shifts (id, doctor_id, weekday, start_time, end_time, effective_from, effective_to, active)
    values (${s.id}, ${s.doctorId}, ${s.weekday}, ${s.start}, ${s.end}, ${s.effectiveFrom}, ${s.effectiveTo}, ${s.active})
    on conflict (id) do update set doctor_id = excluded.doctor_id, weekday = excluded.weekday, start_time = excluded.start_time,
      end_time = excluded.end_time, effective_from = excluded.effective_from, effective_to = excluded.effective_to,
      active = excluded.active, updated_at = now()`;
}

export async function deleteShift(q: Q, id: string): Promise<void> {
  if (isUuid(id)) await q`delete from doctor_shifts where id = ${id}`;
}

export async function upsertDoctor(q: Q, d: Doctor): Promise<void> {
  await q`
    insert into doctors (id, display_name, active) values (${d.id}, ${d.displayName}, ${d.active})
    on conflict (id) do update set display_name = excluded.display_name, active = excluded.active, updated_at = now()`;
}

export async function insertBlock(q: Q, b: BlockRow): Promise<void> {
  await q`
    insert into schedule_blocks (id, weekday, specific_date, start_time, end_time, scope, doctor_id, effective_from, effective_to, reason, active)
    values (${b.id}, ${b.weekday}, ${b.specificDate}, ${b.start}, ${b.end}, ${b.scope}, ${b.doctorId}, ${b.effectiveFrom}, ${b.effectiveTo}, ${b.reason}, ${b.active})`;
}

export async function deleteBlock(q: Q, id: string): Promise<void> {
  if (isUuid(id)) await q`delete from schedule_blocks where id = ${id}`;
}

export async function replaceOpening(q: Q, o: OpeningRow): Promise<void> {
  await q`delete from opening_rules where id <> ${o.id}`;
  await q`
    insert into opening_rules (id, weekdays, start_time, end_time, effective_from, effective_to)
    values (${o.id}, ${o.weekdays}::smallint[], ${o.start}, ${o.end}, ${o.effectiveFrom}, ${o.effectiveTo})
    on conflict (id) do update set weekdays = excluded.weekdays, start_time = excluded.start_time, end_time = excluded.end_time,
      effective_from = excluded.effective_from, effective_to = excluded.effective_to, updated_at = now()`;
}

// ---------- 項目 ----------

export async function insertItem(q: Q, i: Item): Promise<void> {
  await q`insert into appointment_items (id, name, active, sort_order) values (${i.id}, ${i.name}, ${i.active}, ${i.sortOrder})`;
}

export async function updateItemRow(q: Q, i: Item): Promise<void> {
  await q`update appointment_items set name = ${i.name}, active = ${i.active}, sort_order = ${i.sortOrder}, updated_at = now() where id = ${i.id}`;
}

export async function deleteItemRow(q: Q, id: string): Promise<void> {
  if (isUuid(id)) await q`delete from appointment_items where id = ${id}`;
}

// ---------- 系統設定 ----------

export async function saveSettingsRows(q: Q, s: Settings, actorId: string): Promise<void> {
  const rows: [string, unknown][] = [["max_days", s.maxDays], ["notify_emails", s.notifyEmails], ["notify_modes", s.notifyModes]];
  for (const [key, value] of rows) {
    await q`
      insert into system_settings (key, value, updated_by, updated_at) values (${key}, ${q.json(value as never)}, ${actorId}, now())
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
  }
}

// ---------- 帳號與業務名單 ----------

export async function insertUser(q: Q, u: UserAccount): Promise<void> {
  await q`
    insert into user_accounts (id, login_name, password_hash, display_name, role, active)
    values (${u.id}, ${u.loginName}, ${u.passwordHash}, ${u.displayName}, ${u.role}, ${u.active})`;
}

export async function insertSalesperson(q: Q, s: Salesperson): Promise<void> {
  await q`
    insert into salespeople (id, display_name, active, sort_order, user_account_id)
    values (${s.id}, ${s.displayName}, ${s.active}, ${s.sortOrder}, ${s.userAccountId})`;
}

export async function setUserActive(q: Q, id: string, active: boolean): Promise<void> {
  await q`update user_accounts set active = ${active}, updated_at = now() where id = ${id}`;
}

export async function setSalespersonActive(q: Q, id: string, active: boolean): Promise<void> {
  await q`update salespeople set active = ${active}, updated_at = now() where id = ${id}`;
}

export async function setPasswordHash(q: Q, id: string, hash: string): Promise<void> {
  await q`update user_accounts set password_hash = ${hash}, updated_at = now() where id = ${id}`;
}

export async function findUserById(q: Q, id: string): Promise<UserAccount | null> {
  if (!isUuid(id)) return null;
  const [r] = await q`select * from user_accounts where id = ${id}`;
  return r ? mapUser(r) : null;
}

export async function findUserByLogin(q: Q, loginName: string): Promise<UserAccount | null> {
  const [r] = await q`select * from user_accounts where lower(login_name) = lower(${loginName})`;
  return r ? mapUser(r) : null;
}

export async function findSalespersonByUser(q: Q, userId: string): Promise<Salesperson | null> {
  const [r] = await q`select * from salespeople where user_account_id = ${userId}`;
  return r ? mapSalesperson(r) : null;
}

// ---------- Session 與登入失敗 ----------

export async function insertSession(q: Q, tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
  await q`insert into sessions (token_hash, user_id, expires_at) values (${tokenHash}, ${userId}, ${expiresAt})`;
  // 順手清掉過期的 session
  await q`delete from sessions where expires_at < now()`;
}

export async function findSessionUser(q: Q, tokenHash: string): Promise<string | null> {
  const [r] = await q`select user_id from sessions where token_hash = ${tokenHash} and expires_at > now()`;
  return r ? String(r.user_id) : null;
}

export async function deleteSession(q: Q, tokenHash: string): Promise<void> {
  await q`delete from sessions where token_hash = ${tokenHash}`;
}

export async function deleteUserSessions(q: Q, userId: string): Promise<void> {
  await q`delete from sessions where user_id = ${userId}`;
}

/** 目前鎖定到何時（毫秒）；未鎖定回傳 0 */
export async function loginLockedUntil(q: Q, key: string): Promise<number> {
  const [r] = await q`select locked_until from login_failures where login_key = ${key} and locked_until > now()`;
  return r ? (r.locked_until as Date).getTime() : 0;
}

/**
 * 原子地記一次登入失敗（並行嘗試也不會少算）。
 * 上次失敗已超過鎖定時間、或鎖定已過期 → 從 1 重新計算；達到上限即鎖定。
 */
export async function recordLoginFailure(q: Q, key: string, max: number, lockMinutes: number): Promise<void> {
  const lock = `${lockMinutes} minutes`;
  await q`
    insert into login_failures as f (login_key, count, locked_until, updated_at)
    values (${key}, 1, case when 1 >= ${max} then now() + ${lock}::interval end, now())
    on conflict (login_key) do update set
      count = case
        when f.locked_until is not null and f.locked_until <= now() then 1
        when f.updated_at < now() - ${lock}::interval then 1
        else f.count + 1 end,
      locked_until = case
        when (case
          when f.locked_until is not null and f.locked_until <= now() then 1
          when f.updated_at < now() - ${lock}::interval then 1
          else f.count + 1 end) >= ${max} then now() + ${lock}::interval
        end,
      updated_at = now()`;
}

export async function clearLoginFailure(q: Q, key: string): Promise<void> {
  await q`delete from login_failures where login_key = ${key}`;
}

// ---------- 每日日報 ----------

export interface Digest {
  id: string;
  date: string;
  eventCount: number;
  createdAt: string;
  emailSentAt: string | null;
  emailError: string | null;
  emailAttempts: number;
  emailNextAttemptAt: string | null;
}

const mapDigest = (r: Row): Digest => ({
  id: String(r.id), date: String(r.digest_date), eventCount: Number(r.event_count), createdAt: iso(r.created_at),
  emailSentAt: isoOrNull(r.email_sent_at), emailError: (r.email_error as string | null) ?? null,
  emailAttempts: Number(r.email_attempts), emailNextAttemptAt: isoOrNull(r.email_next_attempt_at),
});

/**
 * 建立某日的日報：把所有尚未進過日報的「日報」事件歸入這一封，並排入寄送。
 * 同一天重複呼叫（排程重送）回傳既有的那封；沒有事件回傳 null，不建立。
 */
export async function createDigest(tx: Q, date: string): Promise<{ digest: Digest; created: boolean } | null> {
  await lockKey(tx, `digest:${date}`);
  const [existing] = await tx`select * from email_digests where digest_date = ${date}`;
  if (existing) return { digest: mapDigest(existing), created: false };
  const pending = await tx`
    select id from notifications where email_mode = 'digest' and digest_id is null
    order by created_at for update`; // 等待而非略過：被其他交易暫時鎖住的事件也要進這封
  if (pending.length === 0) return null;
  const [d] = await tx`
    insert into email_digests (digest_date, event_count, email_next_attempt_at)
    values (${date}, ${pending.length}, now()) returning *`;
  await tx`update notifications set digest_id = ${d.id} where id = any(${pending.map((r) => String(r.id))}::uuid[])`;
  return { digest: mapDigest(d), created: true };
}

/** 與 claimDueEmails 相同的租約＋退避 */
export async function claimDueDigests(q: Q, limit: number): Promise<Digest[]> {
  const rows = await q`
    with due as (
      select id from email_digests
      where email_sent_at is null and email_next_attempt_at <= now()
      order by email_next_attempt_at limit ${limit}
      for update skip locked
    )
    update email_digests d set
      email_attempts = d.email_attempts + 1,
      email_next_attempt_at = now() + make_interval(mins => (${EMAIL_BACKOFF_MIN}::int[])[least(d.email_attempts + 1, ${EMAIL_BACKOFF_MIN.length})])
    from due where d.id = due.id
    returning d.*`;
  return rows.map(mapDigest);
}

export async function digestNotifications(q: Q, digestId: string): Promise<Notification[]> {
  const rows = await q`select * from notifications where digest_id = ${digestId} order by created_at`;
  return rows.map(mapNotification);
}

export async function markDigestSent(q: Q, id: string, messageId: string): Promise<void> {
  await q`update email_digests set email_sent_at = now(), email_next_attempt_at = null, email_error = null, email_message_id = ${messageId} where id = ${id}`;
}

export async function markDigestFailed(q: Q, id: string, error: string, stop: boolean): Promise<void> {
  if (stop) await q`update email_digests set email_error = ${error}, email_next_attempt_at = null where id = ${id}`;
  else await q`update email_digests set email_error = ${error} where id = ${id}`;
}

export async function requeueDigest(q: Q, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await q`
    update email_digests set email_next_attempt_at = now(), email_attempts = 0
    where id = ${id} and email_sent_at is null returning id`;
  return rows.length === 1;
}

export async function listDigests(q: Q, limit: number): Promise<Digest[]> {
  const rows = await q`select * from email_digests order by digest_date desc limit ${limit}`;
  return rows.map(mapDigest);
}

export async function pendingDigestCount(q: Q): Promise<number> {
  const [r] = await q`select count(*)::int as n from notifications where email_mode = 'digest' and digest_id is null`;
  return Number(r.n);
}
