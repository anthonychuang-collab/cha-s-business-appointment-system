import Link from "next/link";
import { logoutAction } from "@/app/login/actions";
import type { CurrentUser } from "@/lib/auth/session";
import { unreadNotificationCount } from "@/lib/data/repo";
import { sql } from "@/lib/data/db";

type SalesTab = "home" | "book" | "list";
type AdminTab = "overview" | "schedule" | "options" | "users" | "notifications" | "audit";

export function SalesHeader({ me, tab }: { me: CurrentUser; tab?: SalesTab }) {
  return (
    <header className="top">
      <Link href="/" aria-label="回預約首頁">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand" src="/brand/logo.svg" alt="PURE IN 樸原健康診所" />
      </Link>
      <span className="word">APPOINTMENT</span>
      <nav className="topnav" aria-label="主要選單">
        <Link className={`textbtn ${tab === "home" ? "selected" : ""}`} href="/" aria-current={tab === "home" ? "page" : undefined}>預約首頁</Link>
        <Link className={`textbtn ${tab === "list" ? "selected" : ""}`} href="/appointments" aria-current={tab === "list" ? "page" : undefined}>我的預約</Link>
        <span className="avatar" title={me.user.displayName} aria-hidden>{me.user.displayName.slice(-1)}</span>
        <form action={logoutAction}><button className="textbtn" type="submit">登出</button></form>
      </nav>
    </header>
  );
}

export async function AdminHeader({ me, tab }: { me: CurrentUser; tab: AdminTab }) {
  const isAdmin = me.user.role === "admin";
  const unread = await unreadNotificationCount(sql());
  const tabs: [AdminTab, string, string][] = [
    ["overview", "預約總覽", "/admin"],
    ...(isAdmin
      ? ([
          ["schedule", "醫師班表", "/admin/schedule"],
          ["options", "項目與營業", "/admin/options"],
          ["users", "帳號與權限", "/admin/users"],
          ["audit", "操作紀錄", "/admin/audit"],
        ] as [AdminTab, string, string][])
      : []),
  ];
  return (
    <>
      <header className="top">
        <Link href="/admin" aria-label="回預約總覽">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand" src="/brand/logo.svg" alt="PURE IN 樸原健康診所" />
        </Link>
        <span className="word">{isAdmin ? "MANAGEMENT" : "DEPUTY"}</span>
        <nav className="topnav" aria-label="帳號">
          <Link className={`textbtn bell ${tab === "notifications" ? "selected" : ""}`} href="/admin/notifications">
            通知{unread > 0 && <b aria-label={`${unread} 則未讀`}>{unread}</b>}
          </Link>
          <span className="muted">{me.user.displayName}</span>
          <form action={logoutAction}><button className="textbtn" type="submit">登出</button></form>
        </nav>
      </header>
      <nav className="adminnav" aria-label="後台選單">
        {tabs.map(([id, label, href]) => (
          <Link key={id} href={href} className={tab === id ? "selected" : ""} aria-current={tab === id ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
    </>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <span>PURE IN · 以從容，開始每一次服務。</span>
      <span>{process.env.NODE_ENV !== "production" ? "開發環境 · 測試帳號僅供開發使用" : "樸原健康診所 內部預約系統"}</span>
    </footer>
  );
}
