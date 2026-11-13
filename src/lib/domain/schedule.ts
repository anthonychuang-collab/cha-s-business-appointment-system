/**
 * 班表判斷的唯一來源：某日某一小時是否營業、是否被全院封鎖、哪些醫師完整在班。
 * slots.ts（可約時段）與 conflicts.ts（衝突）都必須用這裡，避免兩邊規則不一致。
 */
import { inDateRange, isoWeekday, timeToMinutes } from "./time";

export interface OpeningRule {
  weekdays: number[];
  start: string;
  end: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface DoctorShift {
  doctorId: string;
  weekday: number;
  start: string;
  end: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

export interface BlockRule {
  /** weekday 與 specificDate 擇一 */
  weekday: number | null;
  specificDate: string | null;
  start: string;
  end: string;
  scope: "clinic" | "doctor";
  doctorId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

export interface ScheduleData {
  openings: OpeningRule[];
  doctors: { id: string; active: boolean }[];
  doctorShifts: DoctorShift[];
  blocks: BlockRule[];
}

export const SLOT_MIN = 60;

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

/** 該日適用的營業設定；休診日回傳 undefined */
export function openingFor(schedule: ScheduleData, date: string): OpeningRule | undefined {
  const weekday = isoWeekday(date);
  return schedule.openings.find((o) => o.weekdays.includes(weekday) && inDateRange(date, o.effectiveFrom, o.effectiveTo));
}

export interface HourCheck {
  withinHours: boolean;
  clinicBlocked: boolean;
  /** 這一小時完整在班、未請假、未停用的醫師 */
  doctorIds: string[];
}

/** 檢查某日從 startMin 起的一小時 */
export function checkHour(schedule: ScheduleData, date: string, startMin: number): HourCheck {
  const weekday = isoWeekday(date);
  const end = startMin + SLOT_MIN;

  const opening = openingFor(schedule, date);
  const withinHours = !!opening && startMin >= timeToMinutes(opening.start) && end <= timeToMinutes(opening.end);

  const blocks = schedule.blocks.filter(
    (b) =>
      b.active && inDateRange(date, b.effectiveFrom, b.effectiveTo) &&
      (b.specificDate !== null ? b.specificDate === date : b.weekday === weekday) &&
      overlaps(startMin, end, timeToMinutes(b.start), timeToMinutes(b.end)),
  );
  const clinicBlocked = blocks.some((b) => b.scope === "clinic");

  const activeDoctors = new Set(schedule.doctors.filter((d) => d.active).map((d) => d.id));
  const onLeave = new Set(blocks.filter((b) => b.scope === "doctor").map((b) => b.doctorId));
  const doctorIds = [
    ...new Set(
      schedule.doctorShifts
        .filter(
          (s) =>
            s.active && s.weekday === weekday && activeDoctors.has(s.doctorId) && !onLeave.has(s.doctorId) &&
            inDateRange(date, s.effectiveFrom, s.effectiveTo) &&
            timeToMinutes(s.start) <= startMin && end <= timeToMinutes(s.end),
        )
        .map((s) => s.doctorId),
    ),
  ];

  return { withinHours, clinicBlocked, doctorIds };
}
