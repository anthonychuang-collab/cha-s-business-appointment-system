import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getOwnAppointment, maxBookableDate, namesOf, pageRef, todayTaipei } from "@/lib/booking";
import { listAudit } from "@/lib/data/repo";
import { actionLabel } from "@/lib/audit-format";
import { taipeiTime } from "@/lib/notify/email";
import { sql } from "@/lib/data/db";
import { minutesUntil } from "@/lib/domain/time";
import { EDIT_LEAD_MIN } from "@/lib/domain/rules";
import { CONFLICT_LABEL, displayDate, STATUS_BADGE, STATUS_LABEL } from "@/lib/format";
import { Footer, SalesHeader } from "@/components/Chrome";
import { BasicsForm, CancelForm, RescheduleForm, ServiceForm } from "./EditForms";

export default async function Detail({ params }: PageProps<"/appointments/[id]">) {
  const { id } = await params;
  const me = await requireUser(["sales"]);
  const a = await getOwnAppointment(me.salesperson!.id, id);
  if (!a) notFound(); // 不是自己的也回 404，不透露是否存在
  const db = await pageRef();
  const { doctorName, itemName, userName } = namesOf(db);
  const maxDate = await maxBookableDate();

  // 介面上的可操作狀態（伺服器送出時仍會用 domain 規則重新檢查）
  const left = minutesUntil(new Date(), a.date, a.start);
  const locked = a.status !== "active" || left <= 0;
  const within4h = left < EDIT_LEAD_MIN;
  const inConflict = a.conflictStatus === "conflict";
  const canTime = !locked && (!within4h || inConflict);
  const canItem = !locked && !within4h;
  const canDoctor = !locked && (!within4h || (inConflict && a.requiresDoctor));
  const lockMsg = a.status !== "active" ? "此預約已非有效狀態，無法修改。" : left <= 0 ? "此預約已開始，無法修改。" : "距開始不足 4 小時，無法變更時間、項目、醫師需求或取消。如需更改請聯絡店長。";

  const items = db.items.filter((i) => i.active || i.id === a.itemId).sort((x, y) => x.sortOrder - y.sortOrder).map((i) => ({ id: i.id, name: i.name }));
  const activeDoctors = new Set(db.doctors.filter((d) => d.active).map((d) => d.id));
  const shiftHints = db.shifts.filter((s) => s.active && activeDoctors.has(s.doctorId)).map((s) => ({ weekday: s.weekday, text: `${db.doctors.find((d) => d.id === s.doctorId)!.displayName} ${s.start}–${s.end}` }));
  // 只有這筆預約的時間軸（動作、誰、何時），不含修改內容與原因；全院操作紀錄僅店長可看（規格 12）
  const history = (await listAudit(sql(), "appointment", a.id)).slice(0, 8);

  return (
    <>
      <SalesHeader me={me} tab="list" />
      <main className="content">
        <Link className="linkbtn" href="/appointments">← 返回我的預約</Link>
        <div className="headrow" style={{ marginTop: 20 }}>
          <div>
            <div className="eyebrow">{a.code}</div>
            <h1>預約詳情</h1>
          </div>
          <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
        </div>

        {inConflict && (
          <div className="conflictbar" role="alert">
            <span>⚠ <strong>此預約需要處理</strong>：{a.conflictReasons.map((r) => CONFLICT_LABEL[r]).join("、")}。請聯絡客戶改期、取消，或改為僅護理師服務（不受 4 小時限制）。</span>
          </div>
        )}
        {a.conflictStatus === "kept" && <p className="alert info">店長已與客戶確認保留：{a.conflictKeptNote}</p>}

        <div className="detailgrid">
          <div>
            <dl className="reviewlist">
              {[
                ["日期時段", `${displayDate(a.date)}　${a.start}–${a.end}`],
                ["客戶", `${a.customerName}　${a.phone}`],
                ["預約項目", `${itemName(a.itemId)}　${a.partySize} 人`],
                ["服務方式", a.requiresDoctor ? `需安排醫師（${doctorName(a.assignedDoctorId)}）` : "僅由護理師服務"],
                ["希望醫師", a.preferredDoctorNote || "無"],
                ["照護備註", a.careNote || "無"],
                ...(a.isOverbooked ? [["超額加開", a.overbookReason]] : []),
              ].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>

            {locked || within4h ? <p className="lockreason" role="note">{inConflict && !locked ? "此預約有衝突，可改期、取消或改為僅護理師。" : lockMsg}</p> : null}

            {!locked && (
              <>
                <details className="editbox">
                  <summary>修改客戶資料與備註</summary>
                  <div><BasicsForm id={a.id} version={a.version} within4h={within4h} values={{ customerName: a.customerName, phone: a.phone, partySize: a.partySize, careNote: a.careNote, preferredDoctorNote: a.preferredDoctorNote }} /></div>
                </details>
                {(canItem || canDoctor) && (
                  <details className="editbox">
                    <summary>修改預約服務</summary>
                    <div><ServiceForm id={a.id} version={a.version} itemId={a.itemId} requiresDoctor={a.requiresDoctor} items={items} canItem={canItem} canDoctor={canDoctor} onlyToNurse={within4h && inConflict} /></div>
                  </details>
                )}
                {canTime && (
                  <details className="editbox" open={inConflict}>
                    <summary>改期</summary>
                    <div><RescheduleForm id={a.id} version={a.version} requiresDoctor={a.requiresDoctor} today={todayTaipei()} maxDate={maxDate} shiftHints={shiftHints} overbooked={a.isOverbooked} /></div>
                  </details>
                )}
                {canTime && <div style={{ marginTop: 24 }}><CancelForm id={a.id} version={a.version} label={`${a.date} ${a.start} ${a.customerName}`} /></div>}
              </>
            )}
          </div>
          <aside className="summary">
            <h3>預約動態</h3>
            <div className="timeline">
              {history.map((l) => (
                <p key={l.id}>{actionLabel(l.entityType, l.action)}<small>{userName(l.actorUserId)}・{taipeiTime(l.createdAt)}</small></p>
              ))}
            </div>
            <p className="muted">修改、改期或取消後，店長會收到通知。</p>
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
