"use server";
import { redirect } from "next/navigation";
import { login, logout } from "@/lib/auth/session";

export type LoginState = { message: string } | null;

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const name = String(form.get("loginName") ?? "");
  const password = String(form.get("password") ?? "");
  if (!name.trim() || !password) return { message: "請輸入帳號與密碼。" };
  const r = await login(name, password);
  if (!r.ok) return { message: r.message };
  redirect(r.role === "sales" ? "/" : "/admin");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}
