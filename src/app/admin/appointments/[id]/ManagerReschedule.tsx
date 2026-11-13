"use client";
import { startTransition, useActionState, useRef } from "react";
import { rescheduleByManager } from "../../actions";

export function ManagerReschedule(props: { id: string; version: number; date: string; start: string; hours: string[]; requiresDoctor: boolean; doctors: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(rescheduleByManager, null);
  const ack = useRef<HTMLInputElement>(null);
  const needConfirm = state?.data === "confirm";
  return (
    <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter); startTransition(() => action(fd)); }}>
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="ack" ref={ack} defaultValue="0" />
      <div className="two">
        <label className="field">新日期<input type="date" name="date" defaultValue={props.date} required /></label>
        <label className="field">新時段
          <select name="start" defaultValue={props.start}>{props.hours.map((h) => <option key={h} value={h}>{h}</option>)}</select>
        </label>
      </div>
      {props.requiresDoctor && (
        <label className="field">安排醫師
          <select name="doctorId" defaultValue=""><option value="">依班表自動安排</option>{props.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </label>
      )}
      <label className="field">超額加開原因<input name="overbookReason" /><small>新時段已有預約時必填。</small></label>
      {state && <p className={state.ok ? "alert info" : "alert"} role={state.ok ? "status" : "alert"}>{state.message}</p>}
      {needConfirm ? (
        <button className="btn small" disabled={pending} onClick={() => { if (ack.current) ack.current.value = "1"; }}>確認仍要改期</button>
      ) : (
        <button className="btn small" disabled={pending}>{pending ? "處理中…" : "改期"}</button>
      )}
    </form>
  );
}
