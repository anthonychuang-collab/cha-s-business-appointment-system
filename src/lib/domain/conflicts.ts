/**
 * 班表衝突判斷（規格 5.5）。純函式。
 * 「衝突」= 已存在的預約在新班表下不再符合規則。容量（超額）與 1 小時規則不算衝突。
 *
 * 保留（kept）規則：店長標記保留時記下當下原因（keptReasons）。
 * 之後重算：原因都在 keptReasons 內 → 維持保留；出現新原因 → 重新衝突；沒有原因 → 恢復正常。
 */
import type { AppointmentStatus, ConflictStatus } from "./rules";
import { minutesUntil, timeToMinutes } from "./time";
import { checkHour, type ScheduleData } from "./schedule";

export type ConflictReason = "OUTSIDE_HOURS" | "BLOCKED" | "DOCTOR_UNAVAILABLE";

export interface ConflictInput {
  date: string;
  start: string;
  requiresDoctor: boolean;
  assignedDoctorId: string | null;
  conflictStatus: ConflictStatus;
  /** 店長標記保留時當下的衝突原因 */
  keptReasons: ConflictReason[];
}

export interface ConflictResult {
  conflictStatus: ConflictStatus;
  /** 固定順序：OUTSIDE_HOURS → BLOCKED → DOCTOR_UNAVAILABLE */
  reasons: ConflictReason[];
  /** 安排的醫師不在時，同一小時仍可安排的其他醫師（供店長參考，不自動替換） */
  alternativeDoctorIds: string[];
}

export function evaluateConflict(a: ConflictInput, schedule: ScheduleData): ConflictResult {
  const { withinHours, clinicBlocked, doctorIds } = checkHour(schedule, a.date, timeToMinutes(a.start));
  const doctorMissing = a.requiresDoctor && (a.assignedDoctorId === null || !doctorIds.includes(a.assignedDoctorId));

  const reasons: ConflictReason[] = [];
  if (!withinHours) reasons.push("OUTSIDE_HOURS");
  if (clinicBlocked) reasons.push("BLOCKED");
  if (doctorMissing) reasons.push("DOCTOR_UNAVAILABLE");

  let conflictStatus: ConflictStatus = "conflict";
  if (reasons.length === 0) conflictStatus = "none";
  else if (a.conflictStatus === "kept" && reasons.every((r) => a.keptReasons.includes(r))) conflictStatus = "kept";

  return {
    conflictStatus,
    reasons,
    alternativeDoctorIds: doctorMissing ? doctorIds.filter((id) => id !== a.assignedDoctorId) : [],
  };
}

export interface ConflictChange {
  id: string;
  from: ConflictStatus;
  to: ConflictStatus;
  reasons: ConflictReason[];
}

/**
 * 班表、請假、營業、休診異動「儲存後」呼叫：傳入所有未來預約，回傳需要更新的那些。
 * 呼叫端依結果更新 conflict_status / conflict_reason，並產生通知。
 * 「儲存前」的影響預覽也可用同一函式，傳入尚未儲存的新班表即可。
 */
export function recomputeConflicts(input: {
  now: Date;
  appointments: (ConflictInput & { id: string; status: AppointmentStatus })[];
  schedule: ScheduleData;
}): ConflictChange[] {
  const changes: ConflictChange[] = [];
  for (const a of input.appointments) {
    if (a.status !== "active") continue;
    if (minutesUntil(input.now, a.date, a.start) <= 0) continue; // 已開始或已過去不動
    const r = evaluateConflict(a, input.schedule);
    if (r.conflictStatus !== a.conflictStatus) changes.push({ id: a.id, from: a.conflictStatus, to: r.conflictStatus, reasons: r.reasons });
  }
  return changes;
}
