import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { listDigests, listNotifications } from "@/lib/admin";
import type { Digest } from "@/lib/data/repo";
import { AdminHeader, Footer } from "@/components/Chrome";
import { ActionForm } from "@/components/ActionForm";
import type { Notification } from "@/lib/data/types";
import { taipeiTime } from "@/lib/notify/email";
import { markAllRead, resendDigestAction, resendEmailAction } from "../actions";

const EVENT = { sales_cancel: "業務取消", sales_edit_within_4h: "4 小時內修改", deputy_action: "代理店長操作", duplicate_phone: "重複電話", sales_edit: "業務修改" } as const;
const MODE = { instant: "即時信", digest: "日報", none: "不寄信" } as const;

type Sendable = { emailSentAt: string | null; emailError: string | null; emailNextAttemptAt: string | null };

/** 寄送狀態：已寄出／寄送中／失敗待重試／失敗已停止（可重新寄送） */
function SendStatus({ x, id, resend }: { x: Sendable; id: string; resend: typeof resendEmailAction }) {
  if (x.emailSentAt) return <small>已寄出 {taipeiTime(x.emailSentAt)}</small>;
  if (x.emailNextAttemptAt && !x.emailError) return <small>寄送中</small>;
  const stopped = !x.emailNextAttemptAt;
  return (
    <>
      <small style={{ color: "var(--red)" }}>
        {stopped ? "寄送失敗" : `寄送失敗，${taipeiTime(x.emailNextAttemptAt!)} 重試`}：{x.emailError}
      </small>
      {stopped && (
        <ActionForm action={resend} submit="重新寄送">
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      )}
    </>
  );
}

function EmailStatus({ n, digests }: { n: Notification; digests: Map<string, Digest> }) {
  if (n.mode === "none") return <>{MODE.none}</>;
  if (n.mode === "instant") return <>即時信<SendStatus x={n} id={n.id} resend={resendEmailAction} /></>;
  const d = n.digestId ? digests.get(n.digestId) : undefined;
  if (!n.digestId) return <>日報<small>待下一封日報（每天 21:00）</small></>;
  return <>日報{d ? <> {d.date}<SendStatus x={d} id={d.id} resend={resendDigestAction} /></> : null}</>;
}

export default async function NotificationsPage() {
  const me = await requireUser(["admin", "deputy"]);
  const [list, digestList] = await Promise.all([listNotifications(200), listDigests(30)]);
  const digests = new Map(digestList.map((d) => [d.id, d]));
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
                    <td><EmailStatus n={n} digests={digests} /></td>
                    <td>{n.appointmentId && <Link className="linkbtn" href={`/admin/appointments/${n.appointmentId}`}>查看 ↗</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2 style={{ marginTop: 48 }}>每日日報</h2>
        <p className="muted">每天 21:00 彙整設定為「日報」的事件寄出一封；當天沒有事件就不寄。</p>
        {digestList.length === 0 ? <p className="empty">尚未寄出任何日報。</p> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>日期</th><th>事件數</th><th>寄送狀態</th></tr></thead>
              <tbody>
                {digestList.slice(0, 14).map((d) => (
                  <tr key={d.id}>
                    <td>{d.date}</td>
                    <td>{d.eventCount} 件</td>
                    <td><SendStatus x={d} id={d.id} resend={resendDigestAction} /></td>
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
