"use client";
import { startTransition, useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, null);
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); startTransition(() => action(fd)); }}>
      <label className="field">
        使用者帳號
        <input name="loginName" autoComplete="username" required aria-invalid={!!state} />
      </label>
      <label className="field">
        密碼
        <input name="password" type="password" autoComplete="current-password" required aria-invalid={!!state} />
      </label>
      {state && <p className="alert" role="alert">{state.message}</p>}
      <button className="btn" type="submit" disabled={pending} style={{ marginTop: 12 }}>
        {pending ? "登入中…" : "登入　→"}
      </button>
    </form>
  );
}
