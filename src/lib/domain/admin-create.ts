/**
 * 店長／代理店長新建預約與超額加開（規格 5.4）。純函式。
 * 與業務不同：不受 1 小時規則與最遠天數限制、可在已占用時段加開（不限筆數）。
 * 但不能繞過營業時間、全院封鎖、醫師班表，也不能約已開始的時段。
 *
 * 呼叫端必須在交易內、已取得時段鎖之後，讀出該時段所有預約傳入 existing。
 */
import { OCCUPYING_STATUSES, type AppointmentStatus } from "./rules";
import { minutesUntil, timeToMinutes } from "./time";
import { checkHour, type ScheduleData } from "./schedule";

export interface SlotBooking {
  status: AppointmentStatus;
  requiresDoctor: boolean;
  assignedDoctorId: string | null;
}

export type AdminCreateWarning = "DOCTOR_DOUBLE_BOOKED";
export type AdminCreateReason = "NOT_ON_HOUR" | "STARTED" | "OUTSIDE_HOURS" | "BLOCKED" | "NO_DOCTOR" | "REASON_REQUIRED";

export type AdminCreateResult =
  | { ok: true; isOverbooked: boolean; assignedDoctorId: string | null; warnings: AdminCreateWarning[] }
  | { ok: false; reason: AdminCreateReason }
  | { ok: false; reason: "NEEDS_CONFIRMATION"; warnings: AdminCreateWarning[] };

export function checkAdminCreate(input: {
  now: Date;
  date: string;
  start: string;
  requiresDoctor: boolean;
  /** 店長手動指定的醫師；null 表示由系統安排 */
  requestedDoctorId: string | null;
  /** 同一日期、同一開始時間的所有預約（含已取消，函式內自行過濾） */
  existing: SlotBooking[];
  overbookReason: string;
  /** 店長已在畫面上確認警告 */
  acknowledgedWarnings: boolean;
  schedule: ScheduleData;
}): AdminCreateResult {
  const { now, date, start, requiresDoctor, requestedDoctorId, schedule } = input;

  if (!/^\d{2}:00$/.test(start)) return { ok: false, reason: "NOT_ON_HOUR" };
  if (minutesUntil(now, date, start) <= 0) return { ok: false, reason: "STARTED" };

  const hour = checkHour(schedule, date, timeToMinutes(start));
  if (!hour.withinHours) return { ok: false, reason: "OUTSIDE_HOURS" };
  if (hour.clinicBlocked) return { ok: false, reason: "BLOCKED" };

  const occupying = input.existing.filter((b) => OCCUPYING_STATUSES.includes(b.status));
  const busyDoctors = new Set(occupying.filter((b) => b.requiresDoctor && b.assignedDoctorId).map((b) => b.assignedDoctorId!));

  let assignedDoctorId: string | null = null;
  if (requiresDoctor) {
    if (requestedDoctorId !== null) {
      if (!hour.doctorIds.includes(requestedDoctorId)) return { ok: false, reason: "NO_DOCTOR" };
      assignedDoctorId = requestedDoctorId;
    } else {
      if (hour.doctorIds.length === 0) return { ok: false, reason: "NO_DOCTOR" };
      // 優先排有空的醫師；都忙才排第一位（並警告）
      assignedDoctorId = hour.doctorIds.find((id) => !busyDoctors.has(id)) ?? hour.doctorIds[0];
    }
  }

  const isOverbooked = occupying.length > 0;
  if (isOverbooked && input.overbookReason.trim() === "") return { ok: false, reason: "REASON_REQUIRED" };

  const warnings: AdminCreateWarning[] = [];
  if (assignedDoctorId !== null && busyDoctors.has(assignedDoctorId)) warnings.push("DOCTOR_DOUBLE_BOOKED");
  if (warnings.length > 0 && !input.acknowledgedWarnings) return { ok: false, reason: "NEEDS_CONFIRMATION", warnings };

  return { ok: true, isOverbooked, assignedDoctorId, warnings };
}
