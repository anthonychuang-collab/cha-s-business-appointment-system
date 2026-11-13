import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/data/store";
import { AdminHeader, Footer } from "@/components/Chrome";
import { markAllRead } from "../actions";

const EVENT = { sales_cancel: "業務取消", sales_edit_within_4h: "4 小時內修改", deputy_action: "代理店長操作", duplicate_phone: "重複電話", sales_edit: "業務修改" } as const;
const MODE = { instant: "即時信", digest: "日報", none: "不寄信" } as const;

export default async function NotificationsPage() {
  const me = await requireUser(["admin", "deputy"]);
  const list = db.notifications.slice(0, 200);
  return (
    <>
      <AdminHeader me={me} tab="notifications" />
      <main className="content">
        <div className="headrow">
          <div><div className="eyebrow">Notifications</div><h1>通知</h1></div>
          <form action={markAllRead}><button className="btn small secondary">全部標為已讀</button></form>
        </div>
        {list.length === 0 ? <p className="empty">目前沒有通知。</p> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>時間</th><th>事件</th><th>內容</th><th>Email</th><th><span className="sr-only">連結</span></th></tr></thead>
              <tbody>
                {list.map((n) => (
                  <tr key={n.id} style={n.readAt ? { color: "var(--muted)" } : undefined}>
                    <td>{new Date(n.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}{!n.readAt && <small style={{ color: "var(--red)" }}>未讀</small>}</td>
                    <td>{EVENT[n.event]}</td>
                    <td>{n.summary}</td>
                    <td>{MODE[n.mode]}</td>
                    <td>{n.appointmentId && <Link className="linkbtn" href={`/admin/appointments/${n.appointmentId}`}>查看 ↗</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
      <Footer />
    </>
  );
}
