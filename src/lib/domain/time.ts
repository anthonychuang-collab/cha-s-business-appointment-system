/**
 * 台北時間工具。主機（Vercel）為 UTC，所有「今天」「距開始幾分鐘」都必須經過這裡。
 * 台灣無日光節約時間，固定 UTC+8。
 */
const TAIPEI_OFFSET_MIN = 8 * 60;

export interface TaipeiMoment {
  /** YYYY-MM-DD（台北） */
  date: string;
  /** 當天 00:00 起算的分鐘數（台北） */
  minutes: number;
}

export function toTaipei(instant: Date): TaipeiMoment {
  const shifted = new Date(instant.getTime() + TAIPEI_OFFSET_MIN * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** 台北某日某時對應的絕對時間 */
export function taipeiToInstant(date: string, time: string): Date {
  const [h, m] = time.split(":").map(Number);
  const utcMidnight = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return new Date(utcMidnight + (h * 60 + m - TAIPEI_OFFSET_MIN) * 60_000);
}

/** ISO 星期：1=週一 … 7=週日 */
export function isoWeekday(date: string): number {
  const d = new Date(date + "T00:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function minutesUntil(now: Date, date: string, time: string): number {
  return Math.floor((taipeiToInstant(date, time).getTime() - now.getTime()) / 60_000);
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 日期是否落在 [from, to]（to 可為 null 表示無截止） */
export function inDateRange(date: string, from: string, to: string | null): boolean {
  return date >= from && (to === null || date <= to);
}
