/**
 * 預約總覽：週檢視（週一到週日）。
 * 電腦：七欄 × 每小時一列的表格；手機：一天一區塊的清單。
 * 只讀取與顯示，不改資料；點日期進日檢視、點預約進詳情、點空格新增。
 */
import Link from "next/link";
import type { Appointment } from "@/lib/data/types";
import type { ScheduleData } from "@/lib/domain/schedule";
import { checkHour, openingFor } from "@/lib/domain/schedule";
import { addDays, isoWeekday } from "@/lib/domain/time";
import { STATUS_LABEL } from "@/lib/format";

const WD = ["", "一", "二", "三", "四", "五", "六", "日"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 該週的週一 */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export interface WeekViewProps {
  date: string;
  today: string;
  /** 本週全部預約（含取消，用來算占用）；visible 為套用篩選後要顯示的 */
  all: Appointment[];
  visible: Appointment[];
  schedule: ScheduleData;
  names: { itemNames: (ids: string[]) => string; doctorName: (id: string | null) => string; salespersonName: (id: string) => string };
  dayHref: (date: string) => string;
}

export function weekStats(date: string, all: Appointment[], schedule: ScheduleData) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart(date), i));
  const active = all.filter((a) => a.status !== "cancelled");
  let open = 0;
  for (const d of days) {
    const o = openingFor(schedule, d);
    if (!o) continue;
    for (let h = Number(o.start.slice(0, 2)); h < Number(o.end.slice(0, 2)); h++) {
      if (!checkHour(schedule, d, h * 60).clinicBlocked && !active.some((a) => a.date === d && a.start === hh(h))) open++;
    }
  }
  return {
    total: active.length,
    withDoctor: active.filter((a) => a.requiresDoctor).length,
    overbooked: active.filter((a) => a.isOverbooked).length,
    open,
  };
}

export function WeekView({ date, today, all, visible, schedule, names, dayHref }: WeekViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart(date), i));
  const openings = days.map((d) => openingFor(schedule, d));
  const starts = openings.filter(Boolean).map((o) => Number(o!.start.slice(0, 2)));
  const ends = openings.filter(Boolean).map((o) => Number(o!.end.slice(0, 2)));
  const hours = starts.length ? Array.from({ length: Math.max(...ends) - Math.min(...starts) }, (_, i) => Math.min(...starts) + i) : [];

  const inOpening = (dayIdx: number, h: number) => {
    const o = openings[dayIdx];
    return !!o && h >= Number(o.start.slice(0, 2)) && h < Number(o.end.slice(0, 2));
  };
  const cellAppts = (d: string, h: number) => visible.filter((a) => a.date === d && a.start === hh(h));
  const occupiedCount = (d: string, h: number) => all.filter((a) => a.date === d && a.start === hh(h) && a.status !== "cancelled").length;
  const dayCount = (d: string) => visible.filter((a) => a.date === d).length;

  const chipClass = (a: Appointment) =>
    ["wk-appt", a.requiresDoctor && "doc", a.isOverbooked && "over", a.conflictStatus === "conflict" && "conflict", a.status !== "active" && "done"]
      .filter(Boolean)
      .join(" ");
  const chipTitle = (a: Appointment) =>
    `${a.start} ${a.customerName}・${a.partySize} 人・${names.itemNames(a.itemIds)}・${a.requiresDoctor ? names.doctorName(a.assignedDoctorId) : "僅護理師"}・${names.salespersonName(a.salespersonId)}・${STATUS_LABEL[a.status]}`;

  return (
    <>
      <div className="wk-legend" aria-hidden>
        <span><i className="wk-key doc" />需醫師</span>
        <span><i className="wk-key over" />超額加開</span>
        <span><i className="wk-key conflict" />衝突待處理</span>
        <span><i className="wk-key blocked" />封鎖</span>
      </div>

      {/* ---------- 電腦：週表格 ---------- */}
      <div className="wk-grid desktop-only" role="table" aria-label="本週預約">
        <div className="wk-corner" role="columnheader" />
        {days.map((d, i) => (
          <Link key={d} href={dayHref(d)} role="columnheader" className={`wk-dayhead ${d === today ? "today" : ""} ${openings[i] ? "" : "closed"}`}>
            <b>{md(d)}</b>
            <span>週{WD[i + 1]}</span>
            <small>{openings[i] ? `${dayCount(d)} 筆` : "休診"}</small>
          </Link>
        ))}
        {hours.map((h) => (
          <div key={h} role="row" className="wk-row">
            <div className="wk-hour" role="rowheader">{hh(h)}</div>
            {days.map((d, i) => {
              if (!inOpening(i, h)) return <div key={d} role="cell" className="wk-cell closed" />;
              const blocked = checkHour(schedule, d, h * 60).clinicBlocked;
              const list = cellAppts(d, h);
              const occupied = occupiedCount(d, h);
              return (
                <div key={d} role="cell" className={`wk-cell ${blocked ? "blocked" : ""} ${occupied > 1 ? "over" : ""} ${d === today ? "today" : ""}`}>
                  {list.map((a) => (
                    <Link key={a.id} href={`/admin/appointments/${a.id}`} className={chipClass(a)} title={chipTitle(a)}>
                      <span className="name">{a.customerName}</span>
                      <span className="who">{names.salespersonName(a.salespersonId)}</span>
                    </Link>
                  ))}
                  {blocked && list.length === 0 && <span className="wk-note">封鎖</span>}
                  {!blocked && occupied === 0 && (
                    <Link className="wk-add" href={`/admin/new?date=${d}&start=${hh(h)}`} aria-label={`${md(d)} ${hh(h)} 新增預約`}>＋</Link>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* ---------- 手機：一天一區塊 ---------- */}
      <div className="wk-list mobile-only">
        {days.map((d, i) => {
          const list = visible.filter((a) => a.date === d).sort((x, y) => x.start.localeCompare(y.start));
          return (
            <section key={d} className={`wk-day ${d === today ? "today" : ""} ${openings[i] ? "" : "closed"}`}>
              <Link href={dayHref(d)} className="wk-dayhead-m">
                <b>{md(d)}（{WD[i + 1]}）</b>
                <span>{openings[i] ? `${list.length} 筆 ›` : "休診"}</span>
              </Link>
              {openings[i] && list.length === 0 && <p className="muted wk-empty">沒有預約</p>}
              {list.map((a) => (
                <Link key={a.id} href={`/admin/appointments/${a.id}`} className={`wk-item ${chipClass(a)}`}>
                  <span className="t">{a.start}</span>
                  <span className="name">{a.customerName}・{a.partySize} 人</span>
                  <span className="who">{names.salespersonName(a.salespersonId)}{a.requiresDoctor ? `・${names.doctorName(a.assignedDoctorId)}` : ""}</span>
                </Link>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
