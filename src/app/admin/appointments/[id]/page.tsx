import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { namesOf, pageRef } from "@/lib/booking";
import { findAppointment, listAudit } from "@/lib/data/repo";
import { sql } from "@/lib/data/db";
import { minutesUntil } from "@/lib/domain/time";
import { actionLabel, auditLines } from "@/lib/audit-format";
import { taipeiTime } from "@/lib/notify/email";
import { CONFLICT_LABEL, displayDate, STATUS_BADGE, STATUS_LABEL } from "@/lib/format";
import { AdminHeader, Footer } from "@/components/Chrome";
import { ActionForm } from "@/components/ActionForm";
import { editByManager, keepConflict, reassign, setStatus } from "../../actions";
import { ManagerReschedule } from "./ManagerReschedule";

export default async function AdminDetail({ params }: PageProps<"/admin/appointments/[id]">) {
  const { id } = await params;
  const me = await requireUser(["admin", "deputy"]);
  const a = await findAppointment(sql(), id);
  if (!a) notFound();
  const db = await pageRef();
  const { doctorName, itemName, salespersonName, userName } = namesOf(db);
  const started = minutesUntil(new Date(), a.date, a.start) <= 0;
  const hidden = <><input type="hidden" name="id" value={a.id} /><input type="hidden" name="version" value={a.version} /></>;
  // 操作紀錄僅店長可看（規格 6、驗收 19：代理店長不可查看）
  const isAdmin = me.user.role === "admin";
  const history = isAdmin ? await listAudit(sql(), "appointment", a.id) : [];
  const opening = db.openings[0];
  const hours = opening ? Array.from({ length: Number(opening.end.slice(0, 2)) - Number(opening.start.slice(0, 2)) }, (_, i) => `${String(Number(opening.start.slice(0, 2)) + i).padStart(2, "0")}:00`) : [];

  return (
    <>
      <AdminHeader me={me} tab="overview" />
      <main className="content">
        <Link className="linkbtn" href={`/admin?date=${a.date}`}>← 返回 {a.date} 總覽</Link>
        <div className="headrow" style={{ marginTop: 20 }}>
          <div><div className="eyebrow">{a.code}</div><h1>{a.customerName}</h1></div>
          <div style={{ display: "flex", gap: 6 }}>
            <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
            {a.isOverbooked && <span className="badge sand">超額加開</span>}
          </div>
        </div>

        {a.conflictStatus === "conflict" && (
          <div className="conflictbar" role="alert"><span>⚠ <strong>衝突</strong>：{a.conflictReasons.map((r) => CONFLICT_LABEL[r]).join("、")}。已顯示在 {salespersonName(a.salespersonId)} 的「我的預約」。</span></div>
        )}

        <div className="detailgrid">
          <div>
            <dl className="reviewlist">
              {[
                ["日期時段", `${displayDate(a.date)}　${a.start}–${a.end}`],
                ["電話", a.phone],
                ["預約項目", `${itemName(a.itemId)}　${a.partySize} 人`],
                ["服務方式", a.requiresDoctor ? `需安排醫師（${doctorName(a.assignedDoctorId)}）` : "僅由護理師服務"],
                ["負責業務", salespersonName(a.salespersonId)],
                ["建立者", userName(a.createdBy)],
                ["希望醫師", a.preferredDoctorNote || "無"],
                ["照護備註", a.careNote || "無"],
                ...(a.isOverbooked ? [["加開原因", a.overbookReason]] : []),
                ...(a.conflictStatus === "kept" ? [["保留原因", a.conflictKeptNote]] : []),
              ].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>

            {a.status !== "cancelled" && (
              <>
                {started && (
                  <div className="panel" style={{ marginTop: 20 }}>
                    <h3>到診狀態</h3>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <ActionForm action={setStatus} submit="標記已到診">{hidden}<input type="hidden" name="status" value="completed" /></ActionForm>
                      <ActionForm action={setStatus} submit="標記未到">{hidden}<input type="hidden" name="status" value="no_show" /></ActionForm>
                    </div>
                  </div>
                )}

                {a.conflictStatus === "conflict" && (
                  <details className="editbox" open>
                    <summary>已與客戶確認，保留原樣</summary>
                    <div>
                      <ActionForm action={keepConflict} submit="標記保留">
                        {hidden}
                        <label className="field">保留原因 <span className="req">*</span><input name="note" required placeholder="例如：客戶同意改由護理師先處理（王小明）" /></label>
                      </ActionForm>
                    </div>
                  </details>
                )}

                {!started && a.status === "active" && (
                  <details className="editbox">
                    <summary>改期</summary>
                    <div><ManagerReschedule id={a.id} version={a.version} date={a.date} start={a.start} hours={hours} requiresDoctor={a.requiresDoctor} doctors={db.doctors.filter((d) => d.active).map((d) => ({ id: d.id, name: d.displayName }))} /></div>
                  </details>
                )}

                <details className="editbox">
                  <summary>修改資料</summary>
                  <div>
                    <ActionForm action={editByManager} submit="儲存">
                      {hidden}
                      <div className="two">
                        <label className="field">預約姓名<input name="customerName" defaultValue={a.customerName} required /></label>
                        <label className="field">聯絡電話<input name="phone" defaultValue={a.phone} required /></label>
                      </div>
                      <div className="two">
                        <label className="field">預約項目
                          <select name="itemId" defaultValue={a.itemId}>
                            {db.items.filter((i) => i.active || i.id === a.itemId).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                          </select>
                        </label>
                        <label className="field">人數<input name="partySize" inputMode="numeric" defaultValue={a.partySize} /></label>
                      </div>
                      <label className="field">希望指定的醫師<input name="preferredDoctorNote" defaultValue={a.preferredDoctorNote} /></label>
                      <label className="field">特殊需求／照護備註<textarea name="careNote" rows={3} defaultValue={a.careNote} /></label>
                    </ActionForm>
                  </div>
                </details>

                <details className="editbox">
                  <summary>轉換負責業務</summary>
                  <div>
                    <ActionForm action={reassign} submit="轉換">
                      {hidden}
                      <label className="field">新的負責業務
                        <select name="salespersonId" defaultValue={a.salespersonId}>
                          {db.salespeople.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}
                        </select>
                      </label>
                    </ActionForm>
                  </div>
                </details>

                {a.status === "active" && (
                  <div style={{ marginTop: 24 }}>
                    <ActionForm action={setStatus} submit="取消這筆預約" danger confirm={`確定取消 ${a.date} ${a.start} ${a.customerName} 的預約？取消後時段會釋出，紀錄會保留。`}>
                      {hidden}<input type="hidden" name="status" value="cancelled" />
                    </ActionForm>
                  </div>
                )}
              </>
            )}
          </div>
          <aside className="summary">
            <h3>操作紀錄</h3>
            {isAdmin ? (
              <div className="timeline">
                {history.map((l) => (
                  <p key={l.id}>
                    {actionLabel(l.entityType, l.action)}{l.reason ? `：${l.reason}` : ""}
                    {auditLines(l, { itemName, doctorName, salespersonName }).map((t, i) => <small key={i}>{t}</small>)}
                    <small>{userName(l.actorUserId)}・{taipeiTime(l.createdAt)}</small>
                  </p>
                ))}
              </div>
            ) : (
              <p className="muted">操作紀錄僅店長可查看。</p>
            )}
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
