import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "node:crypto";
import { sql, type Q } from "@/lib/data/db";
import * as repo from "@/lib/data/repo";
import type { Role, Salesperson, UserAccount } from "@/lib/data/types";
import { verifyPassword } from "./password";

const COOKIE = "sid";
const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 10;

/** 資料庫只存 token 的雜湊 */
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface CurrentUser {
  user: UserAccount;
  /** 業務帳號綁定的業務名單；店長／代理店長為 null */
  salesperson: Salesperson | null;
}

/** 同一個請求內只查一次（layout 與 page 都會呼叫） */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const q = sql();
  const userId = await repo.findSessionUser(q, hashToken(token));
  if (!userId) return null;
  const user = await repo.findUserById(q, userId);
  // 停用帳號立即失效（規格 6）
  if (!user || !user.active) return null;
  let salesperson: Salesperson | null = null;
  if (user.role === "sales") {
    salesperson = await repo.findSalespersonByUser(q, user.id);
    if (!salesperson?.active) return null;
  }
  return { user, salesperson };
});

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
  const q = sql();
  if ((await repo.loginLockedUntil(q, key)) > Date.now()) {
    return { ok: false, message: `登入失敗次數過多，請 ${LOCK_MINUTES} 分鐘後再試。` };
  }
  const user = await repo.findUserByLogin(q, key);
  // 不透露是帳號還是密碼錯誤
  if (!user || !verifyPassword(password, user.passwordHash) || !user.active) {
    await repo.recordLoginFailure(q, key, MAX_FAILURES, LOCK_MINUTES);
    return { ok: false, message: "帳號或密碼不正確，或帳號已停用。" };
  }
  await repo.clearLoginFailure(q, key);
  const token = randomBytes(32).toString("hex");
  await repo.insertSession(q, hashToken(token), user.id, new Date(Date.now() + SESSION_HOURS * 3_600_000));
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
  if (token) await repo.deleteSession(sql(), hashToken(token));
  jar.delete(COOKIE);
}

/** 停用帳號、重設密碼時呼叫：撤銷該帳號所有工作階段（可在交易內呼叫） */
export async function revokeSessions(q: Q, userId: string): Promise<void> {
  await repo.deleteUserSessions(q, userId);
}
