import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/data/store";
import { WEEKDAY_LABEL } from "@/lib/format";
import type { NotifyEvent } from "@/lib/data/types";
import { AdminHeader, Footer } from "@/components/Chrome";
import { ActionForm, PreviewForm } from "@/components/ActionForm";
import { itemAction, saveOpeningAction, settingsAction } from "../actions";

const EVENTS: [NotifyEvent, string][] = [
  ["sales_cancel", "業務取消預約"],
  ["sales_edit_within_4h", "業務在 4 小時內修改"],
  ["deputy_action", "代理店長的任何操作"],
  ["duplicate_phone", "重複電話預約"],
  ["sales_edit", "業務一般修改"],
];

export default async function OptionsPage() {
  const me = await requireUser(["admin"]);
  const items = [...db.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const used = new Set(db.appointments.map((a) => a.itemId));
  const opening = db.openings[0];
  const st = db.settings;

  return (
    <>
      <AdminHeader me={me} tab="options" />
      <main className="content">
        <div className="eyebrow">Service & availability</div>
        <h1>讓每個選項，都清楚有序。</h1>
        <p className="muted">修改後前台立即讀到新設定，不需重新部署。</p>

        <div className="detailgrid" style={{ marginTop: 30 }}>
          <section>
            <h3>預約項目</h3>
            {items.map((i, idx) => (
              <div className="settingsrow" key={i.id}>
                <ActionForm action={itemAction} submit="改名" className="inlineform">
                  <input type="hidden" name="op" value="rename" /><input type="hidden" name="id" value={i.id} />
                  <label className="field"><span className="sr-only">項目名稱</span><input name="name" defaultValue={i.name} /></label>
                </ActionForm>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <ActionForm action={itemAction}><input type="hidden" name="op" value="up" /><input type="hidden" name="id" value={i.id} /><button className="linkbtn" aria-label={`${i.name} 上移`} disabled={idx === 0}>↑</button></ActionForm>
                  <ActionForm action={itemAction}><input type="hidden" name="op" value="down" /><input type="hidden" name="id" value={i.id} /><button className="linkbtn" aria-label={`${i.name} 下移`} disabled={idx === items.length - 1}>↓</button></ActionForm>
                  <ActionForm action={itemAction}>
                    <input type="hidden" name="op" value="toggle" /><input type="hidden" name="id" value={i.id} /><input type="hidden" name="active" value={i.active ? "0" : "1"} />
                    <button className="toggle" role="switch" aria-checked={i.active} aria-label={`${i.name}：${i.active ? "啟用中" : "已停用"}`} />
                  </ActionForm>
                  {!used.has(i.id) && (
                    <ActionForm action={itemAction} confirm={`確定刪除「${i.name}」？`}><input type="hidden" name="op" value="delete" /><input type="hidden" name="id" value={i.id} /><button className="linkbtn" style={{ color: "var(--red)" }}>刪除</button></ActionForm>
                  )}
                </div>
              </div>
            ))}
            <p className="muted">已被預約使用的項目只能停用，不能刪除；歷史預約仍顯示原名稱。</p>
            <ActionForm action={itemAction} submit="新增項目" className="inlineform">
              <input type="hidden" name="op" value="add" />
              <label className="field">新項目名稱<input name="name" /></label>
            </ActionForm>
          </section>

          <section>
            <div className="panel">
              <h3>營業時間</h3>
              <PreviewForm action={saveOpeningAction}>
                <fieldset className="fieldset">
                  <legend>營業日</legend>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
                    {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                      <label key={w} className="check" style={{ marginTop: 0 }}>
                        <input type="checkbox" name="weekdays" value={w} defaultChecked={opening?.weekdays.includes(w)} />{WEEKDAY_LABEL[w]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="two">
                  <label className="field">開始<input type="time" name="start" step={3600} defaultValue={opening?.start ?? "10:00"} /></label>
                  <label className="field">結束<input type="time" name="end" step={3600} defaultValue={opening?.end ?? "19:00"} /></label>
                </div>
                <div className="sumline"><small>每筆預約</small>60 分鐘，整點開始</div>
              </PreviewForm>
              <div className="note">官網頁尾寫週六營業至 17:00，本系統依指定設為 19:00。正式上線前請統一對外資訊。</div>
            </div>

            <div className="panel" style={{ marginTop: 20 }}>
              <h3>預約規則與通知</h3>
              <ActionForm action={settingsAction} submit="儲存設定">
                <label className="field">最遠可預約天數<input name="maxDays" inputMode="numeric" defaultValue={st.maxDays} /><small>業務只能預約今天起算這麼多天內。</small></label>
                <label className="field">通知收件 Email<textarea name="notifyEmails" rows={2} defaultValue={st.notifyEmails.join("\n")} placeholder="一行一個，可填多個" /></label>
                {EVENTS.map(([e, label]) => (
                  <label className="field" key={e}>{label}
                    <select name={`mode_${e}`} defaultValue={st.notifyModes[e]}>
                      <option value="instant">即時寄出</option><option value="digest">每日 21:00 日報</option><option value="none">不寄（只在後台通知）</option>
                    </select>
                  </label>
                ))}
                <p className="devnote">Email 寄送尚未串接（需 Resend 帳號）。目前所有事件都會出現在後台「通知」。</p>
              </ActionForm>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
