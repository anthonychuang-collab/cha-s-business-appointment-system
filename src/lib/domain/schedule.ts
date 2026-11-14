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

// ---------- 營業時間：依星期分別設定（2026-11-14 決策：週六 10:00–17:00） ----------

export interface OpeningDay {
  /** ISO 星期：1 = 週一 … 7 = 週日 */
  weekday: number;
  start: string;
  end: string;
}

const WEEKDAY_NAME = ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const ON_HOUR = /^([01]\d|2[0-3]):00$/;

/** 後台送出的每日營業時間檢查；沒問題回傳 null */
export function validateOpeningDays(days: OpeningDay[]): string | null {
  if (days.length === 0) return "請至少設定一天營業。";
  const seen = new Set<number>();
  for (const d of days) {
    if (!Number.isInteger(d.weekday) || d.weekday < 1 || d.weekday > 7) return "星期不正確。";
    if (seen.has(d.weekday)) return `${WEEKDAY_NAME[d.weekday]}重複設定。`;
    seen.add(d.weekday);
    if (!ON_HOUR.test(d.start) || !ON_HOUR.test(d.end)) return "營業時間請設定為整點。";
    if (d.end <= d.start) return `${WEEKDAY_NAME[d.weekday]}的結束時間需晚於開始時間。`;
  }
  return null;
}

/** 把每日設定轉成營業規則：相同時間的星期合併成一條 */
export function openingRulesFromDays(days: OpeningDay[]): OpeningRule[] {
  const groups = new Map<string, number[]>();
  for (const d of [...days].sort((a, b) => a.weekday - b.weekday)) {
    const key = `${d.start}-${d.end}`;
    groups.set(key, [...(groups.get(key) ?? []), d.weekday]);
  }
  return [...groups.entries()]
    .map(([key, weekdays]) => {
      const [start, end] = key.split("-");
      return { weekdays, start, end, effectiveFrom: "2000-01-01", effectiveTo: null };
    })
    .sort((a, b) => a.weekdays[0] - b.weekdays[0]);
}

/** 營業規則展開成每天的設定（後台表單用） */
export function openingDaysOf(openings: OpeningRule[]): OpeningDay[] {
  return openings.flatMap((o) => o.weekdays.map((weekday) => ({ weekday, start: o.start, end: o.end }))).sort((a, b) => a.weekday - b.weekday);
}

/** 顯示用：「週一至週五 10:00–19:00；週六 10:00–17:00」 */
export function summarizeOpenings(openings: OpeningRule[]): string {
  const label = (ws: number[]) => {
    const sorted = [...ws].sort((a, b) => a - b);
    const consecutive = sorted.every((w, i) => i === 0 || w === sorted[i - 1] + 1);
    if (sorted.length >= 3 && consecutive) return `${WEEKDAY_NAME[sorted[0]]}至${WEEKDAY_NAME[sorted.at(-1)!]}`;
    return sorted.map((w) => WEEKDAY_NAME[w]).join("、");
  };
  return [...openings]
    .sort((a, b) => Math.min(...a.weekdays) - Math.min(...b.weekdays))
    .map((o) => `${label(o.weekdays)} ${o.start}–${o.end}`)
    .join("；");
}

/** 所有營業日中最早開門、最晚關門的整點（跨日期的時段選單用） */
export function openingHourRange(openings: OpeningRule[]): number[] {
  if (openings.length === 0) return [];
  const from = Math.min(...openings.map((o) => Number(o.start.slice(0, 2))));
  const to = Math.max(...openings.map((o) => Number(o.end.slice(0, 2))));
  return Array.from({ length: to - from }, (_, i) => from + i);
}
