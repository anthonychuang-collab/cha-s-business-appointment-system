import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/data/store";
import type { Role, Salesperson, UserAccount } from "@/lib/data/types";
import { verifyPassword } from "./password";

const COOKIE = "sid";
const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 10;

export interface CurrentUser {
  user: UserAccount;
  /** 業務帳號綁定的業務名單；店長／代理店長為 null */
  salesperson: Salesperson | null;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token);
  if (!session || session.expiresAt < Date.now()) return null;
  const user = db.users.find((u) => u.id === session.userId);
  // 停用帳號立即失效（規格 6）
  if (!user || !user.active) return null;
  const salesperson = user.role === "sales" ? db.salespeople.find((s) => s.userAccountId === user.id && s.active) ?? null : null;
  if (user.role === "sales" && !salesperson) return null;
  return { user, salesperson };
}

/** 頁面與 Server Action 共用：未登入導向登入頁；角色不符導向首頁 */
export async function requireUser(roles?: Role[]): Promise<CurrentUser> {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (roles && !roles.includes(current.user.role)) redirect("/");
  return current;
}

export const isManager = (role: Role) => role === "admin" || role === "deputy";

export type LoginResult = { ok: true; role: Role } | { ok: false; message: string };

export async function login(loginName: string, password: string): Promise<LoginResult> {
  const key = loginName.trim().toLowerCase();
  const fail = db.loginFailures.get(key);
  if (fail && fail.until > Date.now()) {
    return { ok: false, message: `登入失敗次數過多，請 ${LOCK_MINUTES} 分鐘後再試。` };
  }
  const user = db.users.find((u) => u.loginName.toLowerCase() === key);
  // 不透露是帳號還是密碼錯誤
  if (!user || !verifyPassword(password, user.passwordHash) || !user.active) {
    const count = (fail && fail.until <= Date.now() ? 0 : fail?.count ?? 0) + 1;
    db.loginFailures.set(key, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MINUTES * 60_000 : 0 });
    return { ok: false, message: "帳號或密碼不正確，或帳號已停用。" };
  }
  db.loginFailures.delete(key);
  const token = randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_HOURS * 3_600_000 });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return { ok: true, role: user.role };
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) db.sessions = db.sessions.filter((s) => s.token !== token);
  jar.delete(COOKIE);
}

/** 停用帳號時呼叫：撤銷該帳號所有工作階段 */
export function revokeSessions(userId: string): void {
  db.sessions = db.sessions.filter((s) => s.userId !== userId);
}
