import { requireUser } from "@/lib/auth/session";
import { pageRef, todayTaipei } from "@/lib/booking";
import { WEEKDAY_LABEL } from "@/lib/format";
import { AdminHeader, Footer } from "@/components/Chrome";
import { ActionForm, PreviewForm } from "@/components/ActionForm";
import { removeBlockAction, removeShiftAction, saveBlockAction, saveDoctorAction, saveShiftAction } from "../actions";

const EN = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function WeekdaySelect({ name = "weekday", value }: { name?: string; value?: number }) {
  return (
    <select name={name} defaultValue={value ?? 1}>
      {[1, 2, 3, 4, 5, 6, 7].map((w) => <option key={w} value={w}>{WEEKDAY_LABEL[w]}</option>)}
    </select>
  );
}

export default async function SchedulePage() {
  const me = await requireUser(["admin"]);
  const today = todayTaipei();
  const db = await pageRef();
  const shifts = [...db.shifts].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  const blocks = db.blocks.filter((b) => b.active && (b.specificDate === null || b.specificDate >= today));

  return (
    <>
      <AdminHeader me={me} tab="schedule" />
      <main className="content">
        <div className="eyebrow">Doctor schedules</div>
        <h1>把專業，安排在對的時間。</h1>
        <p className="muted">班表、請假與封鎖的變更會先列出受影響的預約，確認後才儲存；不會自動取消任何預約。</p>

        <div className="schedule">
          {shifts.map((s) => {
            const doc = db.doctors.find((d) => d.id === s.doctorId)!;
            return (
              <div className="doctor" key={s.id}>
                <div className="day">{EN[s.weekday]}</div>
                <div className="eyebrow">{WEEKDAY_LABEL[s.weekday]}</div>
                <h3>{doc.displayName}</h3>
                <p>{s.start} — {s.end}</p>
                <span className={`badge ${doc.active ? "" : "gray"}`}>{doc.active ? (s.effectiveTo ? `至 ${s.effectiveTo}` : "每週固定") : "醫師停用"}</span>
                <details className="editbox" style={{ background: "transparent" }}>
                  <summary>編輯班表</summary>
                  <div>
                    <PreviewForm action={saveShiftAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="doctorId" value={s.doctorId} />
                      <label className="field">星期<WeekdaySelect value={s.weekday} /></label>
                      <div className="two">
                        <label className="field">開始<input type="time" name="start" step={3600} defaultValue={s.start} /></label>
                        <label className="field">結束<input type="time" name="end" step={3600} defaultValue={s.end} /></label>
                      </div>
                      <div className="two">
                        <label className="field">生效日<input type="date" name="effectiveFrom" defaultValue={s.effectiveFrom} /></label>
                        <label className="field">截止日<input type="date" name="effectiveTo" defaultValue={s.effectiveTo ?? ""} /><small>空白表示無截止</small></label>
                      </div>
                    </PreviewForm>
                    <PreviewForm action={removeShiftAction} previewLabel="刪除此班表（先預覽）">
                      <input type="hidden" name="id" value={s.id} />
                    </PreviewForm>
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        <div className="detailgrid">
          <section className="panel">
            <h3>醫師請假／全院封鎖</h3>
            <p className="muted">個別醫師請假只影響需醫師的預約；全院封鎖影響所有服務。</p>
            <PreviewForm action={saveBlockAction}>
              <div className="two">
                <label className="field">範圍
                  <select name="scope" defaultValue="doctor"><option value="doctor">醫師請假</option><option value="clinic">全院封鎖</option></select>
                </label>
                <label className="field">醫師（請假時）
                  <select name="doctorId" defaultValue=""><option value="">—</option>{db.doctors.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</select>
                </label>
              </div>
              <div className="two">
                <label className="field">頻率
                  <select name="repeat" defaultValue="once"><option value="once">指定日期</option><option value="weekly">每週</option></select>
                </label>
                <label className="field">日期（指定日期時）<input type="date" name="date" min={today} /></label>
              </div>
              <label className="field">星期（每週時）<WeekdaySelect /></label>
              <div className="two">
                <label className="field">開始<input type="time" name="start" step={3600} defaultValue="10:00" /></label>
                <label className="field">結束<input type="time" name="end" step={3600} defaultValue="19:00" /></label>
              </div>
              <label className="field">原因 <span className="req">*</span><input name="reason" placeholder="例如：廖醫師請假、設備維修" /></label>
            </PreviewForm>

            {blocks.length > 0 && (
              <>
                <h3 style={{ marginTop: 28 }}>目前的請假與封鎖</h3>
                {blocks.map((b) => (
                  <div className="settingsrow" key={b.id}>
                    <div>
                      <b>{b.scope === "clinic" ? "全院封鎖" : `${db.doctors.find((d) => d.id === b.doctorId)?.displayName} 請假`}</b>
                      <small>{b.specificDate ?? `每${WEEKDAY_LABEL[b.weekday!]}`}　{b.start}–{b.end}　{b.reason}</small>
                    </div>
                    <ActionForm action={removeBlockAction} submit="移除" danger><input type="hidden" name="id" value={b.id} /></ActionForm>
                  </div>
                ))}
              </>
            )}
          </section>

          <section className="panel">
            <h3>醫師名單</h3>
            {db.doctors.map((d) => (
              <PreviewForm action={saveDoctorAction} key={d.id} className="settingsrow" previewLabel="儲存">
                <input type="hidden" name="id" value={d.id} />
                <label className="field" style={{ margin: 0, flex: 1 }}><span className="sr-only">醫師姓名</span><input name="displayName" defaultValue={d.displayName} /></label>
                <select name="active" defaultValue={d.active ? "1" : "0"} aria-label="狀態"><option value="1">啟用</option><option value="0">停用</option></select>
              </PreviewForm>
            ))}
            <h3 style={{ marginTop: 24 }}>新增醫師</h3>
            <PreviewForm action={saveDoctorAction} previewLabel="新增">
              <label className="field">醫師姓名<input name="displayName" /></label>
            </PreviewForm>
            <h3 style={{ marginTop: 24 }}>新增班表</h3>
            <PreviewForm action={saveShiftAction}>
              <div className="two">
                <label className="field">醫師<select name="doctorId">{db.doctors.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</select></label>
                <label className="field">星期<WeekdaySelect /></label>
              </div>
              <div className="two">
                <label className="field">開始<input type="time" name="start" step={3600} defaultValue="13:00" /></label>
                <label className="field">結束<input type="time" name="end" step={3600} defaultValue="19:00" /></label>
              </div>
              <label className="field">生效日<input type="date" name="effectiveFrom" defaultValue={today} /></label>
            </PreviewForm>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
