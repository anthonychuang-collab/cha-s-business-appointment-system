import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { listNotifications } from "@/lib/admin";
import { AdminHeader, Footer } from "@/components/Chrome";
import { ActionForm } from "@/components/ActionForm";
import type { Notification } from "@/lib/data/types";
import { taipeiTime } from "@/lib/notify/email";
import { markAllRead, resendEmailAction } from "../actions";

const EVENT = { sales_cancel: "業務取消", sales_edit_within_4h: "4 小時內修改", deputy_action: "代理店長操作", duplicate_phone: "重複電話", sales_edit: "業務修改" } as const;
const MODE = { instant: "即時信", digest: "日報", none: "不寄信" } as const;

/** 即時信的寄送狀態 */
function EmailStatus({ n }: { n: Notification }) {
  if (n.mode !== "instant") return <>{MODE[n.mode]}</>;
  if (n.emailSentAt) return <>即時信<small>已寄出 {taipeiTime(n.emailSentAt)}</small></>;
  if (n.emailNextAttemptAt && !n.emailError) return <>即時信<small>寄送中</small></>;
  const stopped = !n.emailNextAttemptAt;
  return (
    <>
      即時信
      <small style={{ color: "var(--red)" }}>
        {stopped ? "寄送失敗" : `寄送失敗，${taipeiTime(n.emailNextAttemptAt!)} 重試`}：{n.emailError}
      </small>
      {stopped && (
        <ActionForm action={resendEmailAction} submit="重新寄送">
          <input type="hidden" name="id" value={n.id} />
        </ActionForm>
      )}
    </>
  );
}

export default async function NotificationsPage() {
  const me = await requireUser(["admin", "deputy"]);
  const list = await listNotifications(200);
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
                    <td><EmailStatus n={n} /></td>
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
