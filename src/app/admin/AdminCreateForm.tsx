"use client";
import { useRef, useState } from "react";
import { ItemPicker } from "@/components/ItemPicker";
import { useRouter } from "next/navigation";
import { createByManager } from "./actions";

/** 店長新增／超額加開。醫師撞時段時先跳警告，確認後帶 acknowledgedWarnings 重送。 */
export function AdminCreateForm(props: {
  date: string;
  start: string;
  hours: string[];
  salespeople: { id: string; name: string }[];
  items: { id: string; name: string }[];
  doctors: { id: string; name: string }[];
  occupiedCount: number;
}) {
  const router = useRouter();
  const key = useRef(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()));
  const [message, setMessage] = useState<{ text: string; field?: string } | null>(null);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requiresDoctor, setRequiresDoctor] = useState(false);

  async function submit(form: HTMLFormElement, ack: boolean) {
    const f = new FormData(form);
    setBusy(true);
    setMessage(null);
    try {
      const r = await createByManager({
        salespersonId: String(f.get("salespersonId")), customerName: String(f.get("customerName")), phone: String(f.get("phone")),
        itemIds: f.getAll("itemIds").map(String), partySize: Number(f.get("partySize")), requiresDoctor, doctorId: String(f.get("doctorId") ?? "") || null,
        date: String(f.get("date")), start: String(f.get("start")), preferredDoctorNote: String(f.get("preferredDoctorNote") ?? ""),
        careNote: String(f.get("careNote") ?? ""), overbookReason: String(f.get("overbookReason") ?? ""), acknowledgedWarnings: ack,
      }, key.current);
      if (r.ok) { router.push(`/admin/appointments/${r.id}`); return; }
      if (r.code === "NEEDS_CONFIRMATION") { setAsk(true); return; }
      setMessage({ text: r.message, field: "field" in r ? r.field : undefined });
    } catch {
      setMessage({ text: "網路連線失敗，資料已保留，請再送出一次（不會重複建立）。" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget, false); }} className="panel">
      <div className="two">
        <label className="field">日期 <span className="req">*</span><input type="date" name="date" defaultValue={props.date} required /></label>
        <label className="field">時段 <span className="req">*</span>
          <select name="start" defaultValue={props.start} required>
            {props.hours.map((h) => <option key={h} value={h}>{h}–{String(Number(h.slice(0, 2)) + 1).padStart(2, "0")}:00</option>)}
          </select>
        </label>
      </div>
      {props.occupiedCount > 0 && <p className="alert info">此時段已有 {props.occupiedCount} 筆預約，送出將成為「超額加開」，請填寫原因。</p>}
      <label className="field">負責業務 <span className="req">*</span>
        <select name="salespersonId" required defaultValue="">
          <option value="" disabled>請選擇</option>
          {props.salespeople.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <div className="two">
        <label className="field">預約姓名 <span className="req">*</span><input name="customerName" required maxLength={50} aria-invalid={message?.field === "customerName"} /></label>
        <label className="field">聯絡電話 <span className="req">*</span><input name="phone" type="tel" required aria-invalid={message?.field === "phone"} /></label>
      </div>
      <ItemPicker items={props.items} legend="預約項目 *" />
      <div className="two">
        <label className="field">人數 <span className="req">*</span><input name="partySize" inputMode="numeric" defaultValue={1} /></label>
      </div>
      <fieldset className="fieldset">
        <legend>是否需要醫師</legend>
        <div className="choices" role="radiogroup">
          <button type="button" className="choice" role="radio" aria-checked={requiresDoctor} onClick={() => setRequiresDoctor(true)}><strong>是，需安排醫師</strong></button>
          <button type="button" className="choice" role="radio" aria-checked={!requiresDoctor} onClick={() => setRequiresDoctor(false)}><strong>否，僅由護理師服務</strong></button>
        </div>
      </fieldset>
      {requiresDoctor && (
        <label className="field">安排醫師
          <select name="doctorId" defaultValue="">
            <option value="">依班表自動安排（優先有空的醫師）</option>
            {props.doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      <label className="field">超額加開原因{props.occupiedCount > 0 && <span className="req"> *</span>}
        <input name="overbookReason" placeholder="例如：同一家人分兩組" aria-invalid={message?.field === "overbookReason"} />
        <small>時段已有預約時必填，會寫入操作紀錄。代理店長請寫上自己的名字。</small>
      </label>
      <label className="field">希望指定的醫師<input name="preferredDoctorNote" maxLength={200} /></label>
      <label className="field">特殊需求／照護備註<textarea name="careNote" rows={3} maxLength={1000} /></label>
      {message && <p className="alert" role="alert">{message.text}</p>}
      {ask && (
        <div className="alert" role="alertdialog" aria-label="確認加開">
          同一時段醫師已有其他預約，確定仍要加開？
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="btn small" disabled={busy} onClick={(e) => { setAsk(false); submit(e.currentTarget.form!, true); }}>確認加開</button>
            <button type="button" className="btn small secondary" onClick={() => setAsk(false)}>取消</button>
          </div>
        </div>
      )}
      <div className="actions">
        <a className="btn secondary" href={`/admin?date=${props.date}`}>返回總覽</a>
        <button className="btn" disabled={busy || ask}>{busy ? "送出中…" : "建立預約"}</button>
      </div>
    </form>
  );
}
