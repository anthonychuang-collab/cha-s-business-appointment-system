import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { itemName, listOwnAppointments } from "@/lib/booking";
import { CONFLICT_LABEL, displayDate, STATUS_BADGE, STATUS_LABEL } from "@/lib/format";
import { Footer, SalesHeader } from "@/components/Chrome";

export default async function MyAppointments({ searchParams }: PageProps<"/appointments">) {
  const sp = await searchParams;
  const q = String(sp.q ?? "").trim();
  const status = String(sp.status ?? "active");
  const onlyConflict = sp.filter === "conflict";
  const me = await requireUser(["sales"]);
  const all = listOwnAppointments(me.salesperson!.id);
  const conflictCount = all.filter((a) => a.status === "active" && a.conflictStatus === "conflict").length;
  const rows = all.filter(
    (a) =>
      (status === "all" || a.status === status) &&
      (!onlyConflict || a.conflictStatus === "conflict") &&
      (!q || a.customerName.includes(q) || a.phone.includes(q) || a.code.includes(q) || itemName(a.itemId).includes(q)),
  );

  return (
    <>
      <SalesHeader me={me} tab="list" />
      <main className="content">
        <div className="headrow">
          <div>
            <div className="eyebrow">My appointments</div>
            <h1>我的預約</h1>
            <p className="muted" style={{ margin: 0 }}>顯示今天與未來、負責業務為你的預約。</p>
          </div>
          <Link className="btn" href="/book">＋ 新增預約</Link>
        </div>

        {conflictCount > 0 && (
          <div className="conflictbar" role="alert">
            <span>⚠ <strong>有 {conflictCount} 筆預約需要處理</strong>：班表異動，請聯絡客戶改期、取消或改為僅護理師。</span>
            {!onlyConflict && <Link className="btn small danger" href="/appointments?filter=conflict&status=all">只看這些</Link>}
          </div>
        )}

        <form className="toolbar" role="search">
          <label className="sr-only" htmlFor="q">搜尋預約</label>
          <input id="q" type="search" name="q" defaultValue={q} placeholder="搜尋姓名、電話、項目或預約編號" />
          <label className="sr-only" htmlFor="status">狀態</label>
          <select id="status" name="status" defaultValue={status}>
            <option value="active">已預約</option>
            <option value="all">全部狀態</option>
            <option value="completed">已到診</option>
            <option value="no_show">未到</option>
            <option value="cancelled">已取消</option>
          </select>
          {onlyConflict && <input type="hidden" name="filter" value="conflict" />}
          <button className="btn small secondary" type="submit">篩選</button>
        </form>

        {rows.length === 0 ? (
          <p className="empty">{all.length === 0 ? "目前沒有預約。" : "沒有符合條件的預約，請調整搜尋文字或狀態。"}</p>
        ) : (
          <>
            <div className="tablewrap desktop-only">
              <table>
                <thead><tr><th>日期 / 時段</th><th>客戶</th><th>預約項目</th><th>狀態</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>{displayDate(a.date)}<small>{a.start}–{a.end}</small></td>
                      <td>{a.customerName}<small>{a.phone}</small></td>
                      <td>{itemName(a.itemId)}<small>{a.partySize} 人・{a.requiresDoctor ? "需醫師" : "僅護理師"}</small></td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
                        {a.conflictStatus === "conflict" && <><br /><span className="badge red" style={{ marginTop: 6 }}>需處理：{a.conflictReasons.map((r) => CONFLICT_LABEL[r]).join("、")}</span></>}
                      </td>
                      <td><Link className="linkbtn" href={`/appointments/${a.id}`}>查看 ↗</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cards mobile-only">
              {rows.map((a) => (
                <Link key={a.id} href={`/appointments/${a.id}`} className={`card ${a.conflictStatus === "conflict" ? "conflict" : ""}`}>
                  <div>
                    <div className="when">{a.date.slice(5).replace("-", "/")}　{a.start}</div>
                    <div className="who">{a.customerName}</div>
                    <div className="meta">{itemName(a.itemId)}・{a.partySize} 人</div>
                    {a.conflictStatus === "conflict" && <div className="meta" style={{ color: "var(--red)" }}>⚠ 需處理：{a.conflictReasons.map((r) => CONFLICT_LABEL[r]).join("、")}</div>}
                  </div>
                  <span className={`badge ${STATUS_BADGE[a.status]}`} style={{ alignSelf: "start" }}>{STATUS_LABEL[a.status]}</span>
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
