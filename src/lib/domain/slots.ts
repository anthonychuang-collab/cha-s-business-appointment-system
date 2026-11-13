/**
 * 可約時段計算（規格 5.2）。純函式：資料由呼叫端從資料庫讀出後傳入。
 * 結果只供前端引導；送出時後端必須在交易內重新呼叫並鎖位。
 */
import { addDays, minutesToTime, minutesUntil, timeToMinutes, toTaipei } from "./time";
import { CREATE_LEAD_MIN } from "./rules";
import { checkHour, openingFor, SLOT_MIN, type ScheduleData } from "./schedule";

export type { OpeningRule, DoctorShift, BlockRule, ScheduleData } from "./schedule";

export type SlotReason = "LEAD_TIME" | "BLOCKED" | "FULL" | "NO_DOCTOR";

export interface Slot {
  start: string;
  end: string;
  available: boolean;
  reason?: SlotReason;
  /** 這一小時完整在班、未被請假封鎖的醫師 */
  doctorIds: string[];
}

export function computeSlots(input: {
  now: Date;
  maxDays: number;
  date: string;
  requiresDoctor: boolean;
  /** 已有占用中預約（active / completed / no_show）的開始時間 */
  occupiedStarts: string[];
  schedule: ScheduleData;
}): Slot[] {
  const { now, maxDays, date, requiresDoctor, occupiedStarts, schedule } = input;
  const today = toTaipei(now).date;
  if (date < today || date > addDays(today, maxDays)) return [];

  const opening = openingFor(schedule, date);
  if (!opening) return [];

  const occupied = new Set(occupiedStarts);
  const close = timeToMinutes(opening.end);
  const slots: Slot[] = [];

  // 從營業開始後第一個整點起算
  for (let t = Math.ceil(timeToMinutes(opening.start) / 60) * 60; t + SLOT_MIN <= close; t += SLOT_MIN) {
    const start = minutesToTime(t);
    const { clinicBlocked, doctorIds } = checkHour(schedule, date, t);

    let reason: SlotReason | undefined;
    if (minutesUntil(now, date, start) < CREATE_LEAD_MIN) reason = "LEAD_TIME";
    else if (clinicBlocked) reason = "BLOCKED";
    else if (occupied.has(start)) reason = "FULL";
    else if (requiresDoctor && doctorIds.length === 0) reason = "NO_DOCTOR";

    slots.push({ start, end: minutesToTime(t + SLOT_MIN), available: reason === undefined, ...(reason && { reason }), doctorIds });
  }
  return slots;
}
