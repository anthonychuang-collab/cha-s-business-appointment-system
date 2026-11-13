import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { namesOf, pageRef, scheduleData, todayTaipei } from "@/lib/booking";
import { listAppointments } from "@/lib/data/repo";
import { sql } from "@/lib/data/db";
import { checkHour, openingFor } from "@/lib/domain/schedule";
import { addDays } from "@/lib/domain/time";
import { CONFLICT_LABEL, displayDate, STATUS_BADGE, STATUS_LABEL } from "@/lib/format";
import { AdminHeader, Footer } from "@/components/Chrome";

export default async function Overview({ searchParams }: PageProps<"/admin">) {
  const me = await requireUser(["admin", "deputy"]);
  const sp = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(sp.date)) ? String(sp.date) : todayTaipei();
  const fSales = String(sp.sales ?? "");
  const fDoctor = String(sp.doctor ?? "");
  const fStatus = String(sp.status ?? "");

  const db = await pageRef();
  const { doctorName, itemName, salespersonName } = namesOf(db);
  const schedule = scheduleData(db);
  const opening = openingFor(schedule, date);
  const dayAll = await listAppointments(sql(), { date });
  const day = dayAll.filter(
    (a) =>
      (!fSales || a.salespersonId === fSales) &&
      (!fDoctor || (fDoctor === "yes" ? a.requiresDoctor : !a.requiresDoctor)) &&
      (fStatus ? a.status === fStatus : a.status !== "cancelled"),
  );
  const hours = opening ? Array.from({ length: (Number(opening.end.slice(0, 2)) - Number(opening.start.slice(0, 2))) }, (_, i) => Number(opening.start.slice(0, 2)) + i) : [];
  const today = todayTaipei();
  const conflicts = await listAppointments(sql(), { status: "active", conflictStatus: "conflict", dateFrom: today });
  const active = dayAll.filter((a) => a.status !== "cancelled");
  const qs = (d: string) => `/admin?date=${d}${fSales ? `&sales=${fSales}` : ""}${fDoctor ? `&doctor=${fDoctor}` : ""}${fStatus ? `&status=${fStatus}` : ""}`;

  return (
    <>
      <AdminHeader me={me} tab="overview" />
      <main className="content">
        <div className="headrow">
          <div>
            <div className="eyebrow">Daily overview</div>
            <h1>{displayDate(date)}</h1>
            <p className="muted" style={{ margin: 0 }}>{opening ? `營業 ${opening.start}–${opening.end}` : "本日休診"}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Link className="btn small secondary" href={qs(addDays(date, -1))} aria-label="前一天">‹ 前一天</Link>
            <Link className="btn small secondary" href={qs(today)}>今天</Link>
            <Link className="btn small secondary" href={qs(addDays(date, 1))} aria-label="後一天">後一天 ›</Link>
            <Link className="btn small" href={`/admin/new?date=${date}`}>＋ 新增預約</Link>
          </div>
        </div>

        {conflicts.length > 0 && (
          <div className="conflictbar" role="alert">
            <span>⚠ <strong>全院共有 {conflicts.length} 筆未來預約需要處理</strong>（班表異動造成，已通知各業務）</span>
            <Link className="btn small danger" href="#conflicts">查看</Link>
          </div>
        )}

        <div className="metrics">
          <div className="metric"><span>本日預約<small>APPOINTMENTS</small></span><b>{String(active.length).padStart(2, "0")}</b></div>
          <div className="metric"><span>需醫師<small>WITH DOCTOR</small></span><b>{String(active.filter((a) => a.requiresDoctor).length).padStart(2, "0")}</b></div>
          <div className="metric"><span>超額加開<small>OVERBOOKED</small></span><b>{String(active.filter((a) => a.isOverbooked).length).padStart(2, "0")}</b></div>
          <div className="metric"><span>空檔<small>OPEN SLOTS</small></span><b>{String(hours.filter((h) => !active.some((a) => a.start === `${String(h).padStart(2, "0")}:00`) && !checkHour(schedule, date, h * 60).clinicBlocked).length).padStart(2, "0")}</b></div>
        </div>

        <form className="toolbar" aria-label="篩選">
          <label className="sr-only" htmlFor="f-sales">負責業務</label>
          <select id="f-sales" name="sales" defaultValue={fSales}>
            <option value="">全部業務</option>
            {db.salespeople.map((s) => <option key={s.id} value={s.id}>{s.displayName}{s.active ? "" : "（停用）"}</option>)}
          </select>
          <label className="sr-only" htmlFor="f-doctor">醫師需求</label>
          <select id="f-doctor" name="doctor" defaultValue={fDoctor}>
            <option value="">醫師需求：全部</option>
            <option value="yes">需醫師</option>
            <option value="no">僅護理師</option>
          </select>
          <label className="sr-only" htmlFor="f-status">狀態</label>
          <select id="f-status" name="status" defaultValue={fStatus}>
            <option value="">未取消</option>
            <option value="active">已預約</option>
            <option value="completed">已到診</option>
            <option value="no_show">未到</option>
            <option value="cancelled">已取消</option>
          </select>
          <input type="date" name="date" defaultValue={date} aria-label="切換日期" />
          <button className="btn small secondary">套用</button>
        </form>

        {!opening ? (
          <div className="hourcell closed"><p>本日休診，不開放預約。</p></div>
        ) : (
          <div className="daygrid">
            {hours.map((h) => {
              const start = `${String(h).padStart(2, "0")}:00`;
              const hour = checkHour(schedule, date, h * 60);
              const list = day.filter((a) => a.start === start);
              const occupied = dayAll.filter((a) => a.start === start && a.status !== "cancelled").length;
              return (
                <section key={start} className={`hourcell ${hour.clinicBlocked ? "blocked" : ""} ${occupied > 1 ? "over" : ""}`} aria-label={`${start} 時段`}>
                  <header>
                    <span>{start}–{String(h + 1).padStart(2, "0")}:00</span>
                    {hour.clinicBlocked ? <span className="badge gray">封鎖</span> : occupied > 1 ? <span className="badge sand">超額 {occupied}</span> : occupied === 1 ? <span className="badge">已預約</span> : <span className="badge gray">空檔</span>}
                  </header>
                  <p className="muted" style={{ margin: "0 0 8px", fontSize: 11 }}>{hour.doctorIds.length ? `醫師：${hour.doctorIds.map((d) => doctorName(d)).join("、")}` : "無醫師"}</p>
                  {list.map((a) => (
                    <div className="appt" key={a.id}>
                      <Link href={`/admin/appointments/${a.id}`} className="linkbtn" style={{ minHeight: 0, padding: 0, fontSize: 14 }}>{a.customerName}・{a.partySize} 人</Link>
                      <div className="meta">{itemName(a.itemId)}・{a.requiresDoctor ? doctorName(a.assignedDoctorId) : "僅護理師"}・{salespersonName(a.salespersonId)}</div>
                      <div className="row">
                        <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
                        {a.isOverbooked && <span className="badge sand">加開</span>}
                        {a.conflictStatus === "conflict" && <span className="badge red">衝突</span>}
                        {a.conflictStatus === "kept" && <span className="badge gray">保留</span>}
                      </div>
                    </div>
                  ))}
                  {!hour.clinicBlocked && (
                    <Link className="linkbtn" href={`/admin/new?date=${date}&start=${start}`}>{occupied ? "＋ 加開" : "＋ 新增"}</Link>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {conflicts.length > 0 && (
          <section id="conflicts" style={{ marginTop: 40 }}>
            <h2>待處理衝突</h2>
            <div className="tablewrap">
              <table>
                <thead><tr><th>日期 / 時段</th><th>客戶</th><th>原因</th><th>負責業務</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>
                  {conflicts.map((a) => (
                    <tr key={a.id}>
                      <td>{displayDate(a.date)}<small>{a.start}–{a.end}</small></td>
                      <td>{a.customerName}<small>{a.phone}</small></td>
                      <td>{a.conflictReasons.map((r) => CONFLICT_LABEL[r]).join("、")}</td>
                      <td>{salespersonName(a.salespersonId)}</td>
                      <td><Link className="linkbtn" href={`/admin/appointments/${a.id}`}>處理 ↗</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}
