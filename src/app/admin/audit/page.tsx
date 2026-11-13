import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { namesOf, pageRef } from "@/lib/booking";
import { searchAudit, type AuditFilter } from "@/lib/data/repo";
import { sql } from "@/lib/data/db";
import { ACTION_OPTIONS, actionLabel, auditLines, ENTITY_LABEL, type EntityType } from "@/lib/audit-format";
import { taipeiTime } from "@/lib/notify/email";
import { AdminHeader, Footer } from "@/components/Chrome";

const PAGE_SIZE = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 操作紀錄查詢：僅店長（規格 6：代理店長與業務不可查看）；唯讀，不提供修改或刪除 */
export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const me = await requireUser(["admin"]);
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");

  const f: AuditFilter = {};
  if (DATE.test(str("from"))) f.from = str("from");
  if (DATE.test(str("to"))) f.to = str("to");
  if (str("type") in ENTITY_LABEL) f.entityType = str("type") as EntityType;
  if (str("actor")) f.actorUserId = str("actor");
  if (ACTION_OPTIONS.some((o) => o.key === str("action"))) f.action = str("action");
  if (str("q")) f.keyword = str("q").slice(0, 100);
  const page = Math.max(1, Math.floor(Number(str("page")) || 1));

  const [ref, { rows, total }] = await Promise.all([pageRef(), searchAudit(sql(), f, PAGE_SIZE, (page - 1) * PAGE_SIZE)]);
  const names = namesOf(ref);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Object.keys(f).length > 0;

  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const k of ["from", "to", "type", "actor", "action", "q"]) if (str(k)) qs.set(k, str(k));
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return `/admin/audit${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <AdminHeader me={me} tab="audit" />
      <main className="content">
        <div className="eyebrow">Audit log</div>
        <h1>操作紀錄</h1>
        <p className="muted">預約、班表、設定與帳號的每一次異動。紀錄由系統自動產生，不能修改或刪除；不記錄密碼，照護備註只記「已修改」。</p>

        <form className="toolbar" aria-label="篩選操作紀錄">
          <label className="sr-only" htmlFor="a-from">開始日期</label>
          <input id="a-from" type="date" name="from" defaultValue={f.from ?? ""} title="開始日期" />
          <span aria-hidden>～</span>
          <label className="sr-only" htmlFor="a-to">結束日期</label>
          <input id="a-to" type="date" name="to" defaultValue={f.to ?? ""} title="結束日期" />
          <label className="sr-only" htmlFor="a-type">對象</label>
          <select id="a-type" name="type" defaultValue={f.entityType ?? ""}>
            <option value="">全部對象</option>
            {Object.entries(ENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="sr-only" htmlFor="a-action">動作</label>
          <select id="a-action" name="action" defaultValue={f.action ?? ""}>
            <option value="">全部動作</option>
            {ACTION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <label className="sr-only" htmlFor="a-actor">操作者</label>
          <select id="a-actor" name="actor" defaultValue={f.actorUserId ?? ""}>
            <option value="">全部操作者</option>
            {ref.users.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.active ? "" : "（停用）"}</option>)}
          </select>
          <label className="sr-only" htmlFor="a-q">關鍵字</label>
          <input id="a-q" type="search" name="q" defaultValue={f.keyword ?? ""} placeholder="預約編號、客戶姓名、原因或內容" />
          <button className="btn small secondary" type="submit">查詢</button>
          {filtered && <Link className="linkbtn" href="/admin/audit">清除條件</Link>}
        </form>

        <p className="muted" aria-live="polite">共 {total} 筆{total > PAGE_SIZE ? `，第 ${page} / ${pages} 頁` : ""}</p>

        {rows.length === 0 ? (
          <p className="empty">{filtered ? "沒有符合條件的紀錄，請調整日期或條件。" : "目前沒有操作紀錄。"}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>時間</th><th>操作者</th><th>對象</th><th>動作</th><th>內容</th></tr></thead>
              <tbody>
                {rows.map((l) => {
                  const lines = auditLines(l, names);
                  return (
                    <tr key={l.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{taipeiTime(l.createdAt)}</td>
                      <td>{l.actorName ?? "系統"}</td>
                      <td>
                        {ENTITY_LABEL[l.entityType]}
                        {l.targetLabel && (
                          <small>
                            {l.entityType === "appointment"
                              ? <Link className="linkbtn" href={`/admin/appointments/${l.entityId}`}>{l.targetLabel}</Link>
                              : l.targetLabel}
                          </small>
                        )}
                      </td>
                      <td>{actionLabel(l.entityType, l.action)}</td>
                      <td>
                        {lines.map((t, i) => <div key={i}>{t}</div>)}
                        {l.reason && <small>原因：{l.reason}</small>}
                        {!lines.length && !l.reason && <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav className="toolbar" aria-label="分頁">
            {page > 1 ? <Link className="btn small secondary" href={href(page - 1)}>← 較新</Link> : null}
            <span className="muted">第 {page} / {pages} 頁</span>
            {page < pages ? <Link className="btn small secondary" href={href(page + 1)}>較舊 →</Link> : null}
          </nav>
        )}
      </main>
      <Footer />
    </>
  );
}
