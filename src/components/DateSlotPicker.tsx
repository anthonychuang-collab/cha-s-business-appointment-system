"use client";
/**
 * 日期＋時段選擇（規格 3.2、3.3）。
 * - 日期：停用過去、超過最遠可約日、無可約時段的日期
 * - 時段：顯示起訖，額滿／截止／無醫師停用
 * - 改日期或醫師需求時重新載入；只清掉已失效的選擇
 */
import { useEffect, useMemo, useState } from "react";
import { fetchMonth, fetchSlots, type SlotView } from "@/app/(sales)/slot-actions";
import { displayDate } from "@/lib/format";

export interface PickValue {
  date: string;
  start: string;
  doctorId: string | null;
  doctorName?: string | null;
}

export interface ShiftHint {
  weekday: number;
  text: string;
}

export function DateSlotPicker(props: {
  today: string;
  maxDate: string;
  requiresDoctor: boolean;
  value: PickValue;
  onChange: (v: PickValue) => void;
  shiftHints: ShiftHint[];
  excludeId?: string;
  error?: string;
}) {
  const { today, maxDate, requiresDoctor, value, onChange, excludeId } = props;
  const initial = value.date || today;
  const [ym, setYm] = useState({ y: Number(initial.slice(0, 4)), m: Number(initial.slice(5, 7)) });
  const [avail, setAvail] = useState<Record<string, boolean> | null>(null);
  const [slots, setSlots] = useState<SlotView[] | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  useEffect(() => {
    let live = true;
    setAvail(null);
    fetchMonth(ym.y, ym.m, requiresDoctor, excludeId).then((r) => live && setAvail(r));
    return () => { live = false; };
  }, [ym.y, ym.m, requiresDoctor, excludeId]);

  useEffect(() => {
    if (!value.date) { setSlots(null); return; }
    let live = true;
    setLoadingSlots(true);
    fetchSlots(value.date, requiresDoctor, excludeId).then((r) => {
      if (!live) return;
      setSlots(r);
      setLoadingSlots(false);
      // 只清除已失效的時段選擇
      const chosen = r.find((s) => s.start === value.start);
      if (value.start && (!chosen || !chosen.available)) onChange({ ...value, start: "", doctorId: null, doctorName: null });
      else if (chosen && requiresDoctor) {
        const ok = chosen.doctors.some((d) => d.id === value.doctorId);
        const only = chosen.doctors.length === 1 ? chosen.doctors[0] : null;
        if (!ok) onChange({ ...value, doctorId: only?.id ?? null, doctorName: only?.name ?? null });
      } else if (chosen && !requiresDoctor && value.doctorId) onChange({ ...value, doctorId: null, doctorName: null });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.date, requiresDoctor, excludeId]);

  const days = useMemo(() => {
    const first = new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate();
    return { first, count };
  }, [ym]);

  const minYm = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
  const maxYm = Number(maxDate.slice(0, 4)) * 12 + Number(maxDate.slice(5, 7));
  const cur = ym.y * 12 + ym.m;
  const move = (n: number) => {
    const t = cur + n - 1;
    setYm({ y: Math.floor(t / 12), m: (t % 12) + 1 });
  };

  const weekday = value.date ? ((new Date(value.date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1 : 0;
  const hints = props.shiftHints.filter((h) => h.weekday === weekday);
  const chosen = slots?.find((s) => s.start === value.start);

  return (
    <div>
      <div className="calendarhead">
        <button type="button" aria-label="上一個月" onClick={() => move(-1)} disabled={cur <= minYm}>‹</button>
        <b aria-live="polite">{ym.y} / {String(ym.m).padStart(2, "0")}</b>
        <button type="button" aria-label="下一個月" onClick={() => move(1)} disabled={cur >= maxYm}>›</button>
      </div>
      <div className="week" aria-hidden>{"日一二三四五六".split("").map((d) => <div key={d}>{d}</div>)}</div>
      <div className="calendar" role="group" aria-label="選擇日期">
        {Array.from({ length: days.first }, (_, i) => <span key={`b${i}`} />)}
        {Array.from({ length: days.count }, (_, i) => {
          const d = `${ym.y}-${String(ym.m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
          const off = d < today || d > maxDate || (avail !== null && !avail[d]);
          return (
            <button
              type="button" key={d} disabled={off || avail === null}
              className={d === today ? "today" : ""}
              aria-pressed={value.date === d}
              aria-label={`${displayDate(d)}${off ? "，不可預約" : ""}`}
              onClick={() => onChange(value.date === d ? value : { date: d, start: "", doctorId: null, doctorName: null })}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      <p className="schedulehint">可預約至 {displayDate(maxDate)}。週日休診，劃線日期為不可預約。</p>

      {value.date && (
        <>
          <div className="note">
            {displayDate(value.date)}
            <br />
            {hints.length ? `醫師班表：${hints.map((h) => h.text).join("、")}` : "當日無醫師門診班表，僅可安排護理師服務。"}
          </div>
          <div className="slots" role="group" aria-label="選擇時段" aria-busy={loadingSlots}>
            {slots?.map((s) => (
              <button
                type="button" key={s.start} className="slot" disabled={!s.available}
                aria-pressed={value.start === s.start}
                onClick={() => {
                  const only = requiresDoctor && s.doctors.length === 1 ? s.doctors[0] : null;
                  onChange({ ...value, start: s.start, doctorId: only?.id ?? null, doctorName: only?.name ?? null });
                }}
              >
                {s.start}–{s.end}
                <small>{s.label}</small>
              </button>
            ))}
          </div>
          {slots && !slots.some((s) => s.available) && <p className="alert info" role="status">此日期目前無可預約時段，請選擇其他日期。</p>}
          {requiresDoctor && chosen && chosen.doctors.length > 1 && (
            <label className="field" style={{ marginTop: 18 }}>
              安排醫師 <span className="req">*</span>
              <select value={value.doctorId ?? ""} onChange={(e) => onChange({ ...value, doctorId: e.target.value || null, doctorName: chosen.doctors.find((d) => d.id === e.target.value)?.name ?? null })}>
                <option value="">請選擇</option>
                {chosen.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          {requiresDoctor && chosen && chosen.doctors.length === 1 && (
            <p className="note">安排醫師：{chosen.doctors[0].name}</p>
          )}
        </>
      )}
      {props.error && <p className="error" role="alert">{props.error}</p>}
    </div>
  );
}
