"use client";
import { startTransition, useActionState, useState, useTransition } from "react";
import { ItemPicker } from "@/components/ItemPicker";
import { DateSlotPicker, type PickValue, type ShiftHint } from "@/components/DateSlotPicker";
import { cancelAppointment, reschedule, saveBasics, saveService, type FormState } from "./actions";

function Result({ state }: { state: FormState }) {
  if (!state) return null;
  return <p className={state.ok ? "alert info" : "alert"} role={state.ok ? "status" : "alert"}>{state.message}</p>;
}

export function BasicsForm(props: { id: string; version: number; values: { customerName: string; phone: string; partySize: number; careNote: string; preferredDoctorNote: string }; within4h: boolean }) {
  const [state, action, pending] = useActionState(saveBasics, null);
  const v = props.values;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter); startTransition(() => action(fd)); }}>
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="orig" value={JSON.stringify({ ...v, partySize: String(v.partySize) })} />
      <div className="two">
        <label className="field">預約姓名<input name="customerName" defaultValue={v.customerName} maxLength={50} required /></label>
        <label className="field">聯絡電話<input name="phone" type="tel" defaultValue={v.phone} required /></label>
      </div>
      <label className="field">預約人數<input name="partySize" inputMode="numeric" defaultValue={v.partySize} /></label>
      <label className="field">希望指定的醫師<input name="preferredDoctorNote" defaultValue={v.preferredDoctorNote} maxLength={200} /><small>希望安排，不代表已確認。</small></label>
      <label className="field">特殊需求／照護備註<textarea name="careNote" rows={3} defaultValue={v.careNote} maxLength={1000} /></label>
      {props.within4h && <p className="lockreason">距開始不足 4 小時，修改後會通知店長。</p>}
      <Result state={state} />
      <button className="btn small" disabled={pending}>{pending ? "儲存中…" : "儲存變更"}</button>
    </form>
  );
}

export function ServiceForm(props: { id: string; version: number; itemIds: string[]; requiresDoctor: boolean; items: { id: string; name: string }[]; canItem: boolean; canDoctor: boolean; onlyToNurse: boolean }) {
  const [state, action, pending] = useActionState(saveService, null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter); startTransition(() => action(fd)); }}>
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="orig" value={JSON.stringify({ itemIds: props.itemIds, requiresDoctor: props.requiresDoctor })} />
      <ItemPicker items={props.items} defaultSelected={props.itemIds} disabled={!props.canItem} />
      <fieldset className="fieldset" disabled={!props.canDoctor}>
        <legend>是否需要醫師</legend>
        <label className="check" style={{ marginTop: 0 }}>
          <input type="radio" name="requiresDoctor" value="yes" defaultChecked={props.requiresDoctor} disabled={props.onlyToNurse} /> 是，需安排醫師
        </label>
        <label className="check" style={{ marginTop: 0 }}>
          <input type="radio" name="requiresDoctor" value="no" defaultChecked={!props.requiresDoctor} /> 否，僅由護理師服務
        </label>
      </fieldset>
      {!props.canDoctor && <input type="hidden" name="requiresDoctor" value={props.requiresDoctor ? "yes" : "no"} />}
      <Result state={state} />
      <button className="btn small" disabled={pending || (!props.canItem && !props.canDoctor)}>{pending ? "儲存中…" : "更新服務"}</button>
    </form>
  );
}

export function RescheduleForm(props: { id: string; version: number; requiresDoctor: boolean; today: string; maxDate: string; shiftHints: ShiftHint[]; overbooked: boolean }) {
  const [pick, setPick] = useState<PickValue>({ date: "", start: "", doctorId: null });
  const [state, setState] = useState<FormState>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      {props.overbooked && <p className="alert">此預約為店長加開的超額預約。改期後無法改回原時段，如需保留請聯絡店長。</p>}
      <DateSlotPicker today={props.today} maxDate={props.maxDate} requiresDoctor={props.requiresDoctor} value={pick} onChange={setPick} shiftHints={props.shiftHints} excludeId={props.id} />
      <Result state={state} />
      <button
        type="button" className="btn small" style={{ marginTop: 16 }}
        disabled={pending || !pick.start || (props.requiresDoctor && !pick.doctorId)}
        onClick={() => start(async () => setState(await reschedule(props.id, props.version, pick.date, pick.start, pick.doctorId)))}
      >
        {pending ? "改期中…" : pick.start ? `改到 ${pick.date} ${pick.start}` : "請先選擇新時段"}
      </button>
    </div>
  );
}

export function CancelForm(props: { id: string; version: number; label: string }) {
  const [state, action, pending] = useActionState(cancelAppointment, null);
  const [ask, setAsk] = useState(false);
  if (state?.ok) return <Result state={state} />;
  return (
    <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter); startTransition(() => action(fd)); }}>
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />
      {!ask ? (
        <button type="button" className="btn small danger" onClick={() => setAsk(true)}>取消這筆預約</button>
      ) : (
        <div className="alert" role="alertdialog" aria-label="確認取消">
          確定取消「{props.label}」？取消後時段會釋出，紀錄會保留。
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn small" disabled={pending}>{pending ? "取消中…" : "確認取消"}</button>
            <button type="button" className="btn small secondary" onClick={() => setAsk(false)}>保留預約</button>
          </div>
        </div>
      )}
      <Result state={state} />
    </form>
  );
}
