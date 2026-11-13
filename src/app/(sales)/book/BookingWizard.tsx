"use client";
/**
 * 四步驟預約（規格 3.1）：客戶資料 → 預約服務 → 預約時間 → 備註與確認。
 * - 按「下一步」才前進，檢查當前步驟欄位，錯誤顯示在欄位旁並把焦點移到第一個錯誤
 * - 上一步保留資料；資料只存在記憶體（不寫 localStorage、不放網址）
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DateSlotPicker, type PickValue, type ShiftHint } from "@/components/DateSlotPicker";
import { displayDate, endOf } from "@/lib/format";
import { submitBooking } from "./actions";

type Errors = Partial<Record<"customerName" | "phone" | "itemId" | "partySize" | "requiresDoctor" | "slot" | "agree" | "form", string>>;

const STEPS = ["客戶資料", "預約服務", "預約時間", "確認送出"];
const ITEM_HINT: Record<string, string> = {
  一般健保看診: "一般門診照護", 一般自費看診: "自費醫療服務", 療程諮詢: "了解適合的服務安排",
  例行保養與療程: "持續照護與定期回訪", "點滴／針劑": "安排點滴或針劑服務", 疫苗: "疫苗接種預約", 其他: "其他預約需求",
};

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

export function BookingWizard(props: {
  salespersonName: string;
  items: { id: string; name: string }[];
  today: string;
  maxDate: string;
  shiftHints: ShiftHint[];
  weeklyDoctors: string[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [customerName, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [itemId, setItemId] = useState("");
  const [partySize, setPartySize] = useState("1");
  const [requiresDoctor, setRequiresDoctor] = useState<boolean | null>(null);
  const [pick, setPick] = useState<PickValue>({ date: "", start: "", doctorId: null });
  const [preferredDoctorNote, setPreferred] = useState("");
  const [careNote, setCareNote] = useState("");
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [dupAsk, setDupAsk] = useState(false);
  const idemKey = useRef(newKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  // 焦點移到第一個錯誤
  useEffect(() => {
    const el = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], .error[role='alert']");
    el?.focus?.();
  }, [errors]);

  function validate(s: number): Errors {
    const e: Errors = {};
    if (s === 0) {
      if (!customerName.trim()) e.customerName = "請填寫預約姓名。";
      const digits = phone.split(/#|轉|ext\.?/i)[0].replace(/[^\d+]/g, "").replace(/^\+886/, "0");
      if (!/^0\d{8,9}$/.test(digits)) e.phone = "請填寫有效電話（手機 09 開頭或含區碼市話，可加分機）。";
    }
    if (s === 1) {
      if (!itemId) e.itemId = "請選擇預約項目。";
      if (!/^\d+$/.test(partySize) || Number(partySize) < 1) e.partySize = "人數需為 1 以上的整數。";
      if (requiresDoctor === null) e.requiresDoctor = "請選擇是否需要醫師。";
    }
    if (s === 2) {
      if (!pick.date || !pick.start) e.slot = "請選擇日期與時段。";
      else if (requiresDoctor && !pick.doctorId) e.slot = "請選擇安排的醫師。";
    }
    if (s === 3 && !agree) e.agree = "請勾選確認預約資料正確。";
    return e;
  }

  function next() {
    const e = validate(step);
    setErrors(e);
    if (Object.keys(e).length === 0) setStep(step + 1);
  }

  async function submit(confirmDuplicate = false) {
    const e = validate(3);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await submitBooking(
        { customerName, phone, itemId, partySize: Number(partySize), requiresDoctor: requiresDoctor === true, doctorId: pick.doctorId, date: pick.date, start: pick.start, preferredDoctorNote, careNote },
        idemKey.current, confirmDuplicate,
      );
      if (r.ok) { router.push(`/book/done/${r.id}`); return; }
      if (r.code === "DUPLICATE_PHONE") { setDupAsk(true); return; }
      // 時段被搶走：回到時段步驟，其他資料保留
      if ("field" in r && r.field === "start") {
        setPick({ ...pick, start: "", doctorId: null, doctorName: null });
        setStep(2);
        setErrors({ slot: r.message });
        return;
      }
      const map: Record<string, number> = { customerName: 0, phone: 0, itemId: 1, partySize: 1 };
      if ("field" in r && r.field && r.field in map) { setStep(map[r.field]); setErrors({ [r.field]: r.message }); return; }
      setErrors({ form: r.message });
    } catch {
      setErrors({ form: "網路連線失敗，資料已保留，請再按一次送出（不會重複建立）。" });
    } finally {
      setBusy(false);
    }
  }

  const item = props.items.find((i) => i.id === itemId);
  const err = (k: keyof Errors) => errors[k] && <span className="fielderr" id={`err-${k}`}>{errors[k]}</span>;

  return (
    <>
      <ol className="steps" aria-label="預約進度">
        {STEPS.map((label, i) => (
          <li key={label} className={i <= step ? "on" : ""} aria-current={i === step ? "step" : undefined} style={{ display: "contents" }}>
            {i > 0 && <i aria-hidden />}
            <div className={i <= step ? "on" : ""} style={{ display: "flex", alignItems: "center", gap: 8, flexDirection: "inherit" }}>
              <b aria-hidden>{i < step ? "✓" : i + 1}</b>
              <span>{label}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">步驟 {step + 1}／4：{STEPS[step]}</p>

      <div className="formgrid">
        <div ref={formRef}>
          {step === 0 && (
            <>
              <div className="formhead">
                <div className="eyebrow">01 / Client information</div>
                <h1 tabIndex={-1} ref={headingRef}>先認識這次的來訪者</h1>
              </div>
              <p className="fixedby">負責業務：{props.salespersonName}</p>
              <div className="two">
                <label className="field">
                  預約姓名 <span className="req">*</span>
                  <input value={customerName} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={50}
                    aria-invalid={!!errors.customerName} aria-describedby={errors.customerName ? "err-customerName" : undefined} />
                  {err("customerName")}
                </label>
                <label className="field">
                  聯絡電話 <span className="req">*</span>
                  <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" placeholder="0912-345-678 或 02-2345-6789#12"
                    aria-invalid={!!errors.phone} aria-describedby={errors.phone ? "err-phone" : "hint-phone"} />
                  {err("phone") || <small id="hint-phone">支援手機、市話與分機。</small>}
                </label>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="formhead">
                <div className="eyebrow">02 / Purpose of visit</div>
                <h1 tabIndex={-1} ref={headingRef}>這次，想安排什麼服務？</h1>
              </div>
              <fieldset className="fieldset" aria-invalid={!!errors.itemId}>
                <legend>預約項目 <span className="req" style={{ color: "var(--brown)" }}>*</span></legend>
                <div className="choices" role="radiogroup">
                  {props.items.map((i) => (
                    <button type="button" key={i.id} className="choice" role="radio" aria-checked={itemId === i.id} onClick={() => setItemId(i.id)}>
                      <strong>{i.name}</strong>
                      <small>{ITEM_HINT[i.name] ?? "預約服務"}</small>
                    </button>
                  ))}
                </div>
                {err("itemId")}
              </fieldset>
              <label className="field">
                預約人數 <span className="req">*</span>
                <div className="stepper">
                  <button type="button" aria-label="減少人數" onClick={() => setPartySize(String(Math.max(1, Number(partySize) - 1 || 1)))}>－</button>
                  <input inputMode="numeric" value={partySize} onChange={(e) => setPartySize(e.target.value.replace(/\D/g, ""))}
                    aria-invalid={!!errors.partySize} aria-label="預約人數" />
                  <button type="button" aria-label="增加人數" onClick={() => setPartySize(String((Number(partySize) || 0) + 1))}>＋</button>
                </div>
                {err("partySize") || <small>多人同行仍占同一個一小時時段。</small>}
              </label>
              <fieldset className="fieldset">
                <legend>是否需要醫師 <span style={{ color: "var(--brown)" }}>*</span></legend>
                <div className="choices" role="radiogroup">
                  <button type="button" className="choice" role="radio" aria-checked={requiresDoctor === true} onClick={() => setRequiresDoctor(true)}>
                    <strong>是，需安排醫師</strong><small>僅能選擇醫師出診時段</small>
                  </button>
                  <button type="button" className="choice" role="radio" aria-checked={requiresDoctor === false} onClick={() => setRequiresDoctor(false)}>
                    <strong>否，僅由護理師服務</strong><small>營業時間內皆可預約</small>
                  </button>
                </div>
                {err("requiresDoctor")}
              </fieldset>
              {props.weeklyDoctors.length > 0 && <p className="note">醫師出診：{props.weeklyDoctors.join("；")}</p>}
            </>
          )}

          {step === 2 && (
            <>
              <div className="formhead">
                <div className="eyebrow">03 / Date & time</div>
                <h1 tabIndex={-1} ref={headingRef}>選一個，剛剛好的時間。</h1>
                <p className="muted">每次預約 60 分鐘，同一時段僅開放一筆預約。</p>
              </div>
              <DateSlotPicker
                today={props.today} maxDate={props.maxDate} requiresDoctor={requiresDoctor === true}
                value={pick} onChange={setPick} shiftHints={props.shiftHints} error={errors.slot}
              />
            </>
          )}

          {step === 3 && (
            <>
              <div className="formhead">
                <div className="eyebrow">04 / Review appointment</div>
                <h1 tabIndex={-1} ref={headingRef}>再確認一次，就準備好了。</h1>
              </div>
              <label className="field">
                希望指定的醫師 <span className="muted">（選填）</span>
                <input value={preferredDoctorNote} onChange={(e) => setPreferred(e.target.value)} maxLength={200} />
                <small>僅為希望安排，不代表已確認；實際醫師依班表。</small>
              </label>
              <label className="field">
                特殊需求／照護備註 <span className="muted">（選填）</span>
                <textarea rows={3} value={careNote} onChange={(e) => setCareNote(e.target.value)} maxLength={1000} placeholder="例如：怕痛、不好打針、行動需協助" />
              </label>
              <dl className="reviewlist">
                {[
                  ["負責業務", props.salespersonName],
                  ["客戶", `${customerName}　${phone}`],
                  ["預約項目", `${item?.name ?? ""}　${partySize} 人`],
                  ["服務方式", requiresDoctor ? "需安排醫師" : "僅由護理師服務"],
                  ["日期時段", pick.date ? `${displayDate(pick.date)}　${pick.start}–${endOf(pick.start)}` : ""],
                  ...(requiresDoctor ? [["安排醫師", pick.doctorName ?? "依班表"]] : []),
                  ["備註", [preferredDoctorNote && `希望醫師：${preferredDoctorNote}`, careNote].filter(Boolean).join("\n") || "無"],
                ].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
                <button type="button" className="linkbtn" onClick={() => setStep(0)}>修改客戶資料</button>
                <button type="button" className="linkbtn" onClick={() => setStep(1)}>修改服務</button>
                <button type="button" className="linkbtn" onClick={() => setStep(2)}>修改時間</button>
              </div>
              <label className="check">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-invalid={!!errors.agree} />
                我已確認以上預約資料正確
              </label>
              {err("agree")}
              {dupAsk && (
                <div className="alert" role="alertdialog" aria-labelledby="dup-title">
                  <strong id="dup-title">此電話已有預約，確定要再建立一筆嗎？</strong>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button type="button" className="btn small" disabled={busy} onClick={() => { setDupAsk(false); submit(true); }}>確定建立</button>
                    <button type="button" className="btn small secondary" onClick={() => setDupAsk(false)}>先不要</button>
                  </div>
                </div>
              )}
            </>
          )}

          {errors.form && <p className="alert" role="alert">{errors.form}</p>}

          <div className="actions">
            {step === 0
              ? <a className="btn secondary" href="/">返回首頁</a>
              : <button type="button" className="btn secondary" onClick={() => { setErrors({}); setStep(step - 1); }}>← 上一步</button>}
            {step < 3
              ? <button type="button" className="btn" onClick={next}>下一步　→</button>
              : <button type="button" className="btn" disabled={busy || dupAsk} onClick={() => submit(false)}>{busy ? "送出中…" : "確認送出　↗"}</button>}
          </div>
        </div>

        <aside className="summary side" aria-label="預約摘要">
          <div className="eyebrow">Your appointment</div>
          <div className="serif">預約摘要</div>
          <div className="sumline"><small>負責業務</small>{props.salespersonName}</div>
          <div className="sumline"><small>客戶</small>{customerName || "尚未填寫"}</div>
          <div className="sumline"><small>預約項目</small>{item ? `${item.name}・${partySize} 人` : "尚未選擇"}</div>
          <div className="sumline"><small>服務方式</small>{requiresDoctor === null ? "尚未選擇" : requiresDoctor ? "需安排醫師" : "僅護理師"}</div>
          <div className="sumline"><small>預約時間</small>{pick.date && pick.start ? <>{displayDate(pick.date)}<br />{pick.start} – {endOf(pick.start)}</> : "尚未選擇"}</div>
          <div className="note">每次服務保留 60 分鐘，<br />讓每一次到訪都被好好安排。</div>
        </aside>
      </div>
    </>
  );
}

