import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const me = await getCurrentUser();
  if (me) redirect(me.user.role === "sales" ? "/" : "/admin");
  return (
    <main className="login">
      <div className="loginvisual">
        <div className="eyebrow">Pure in · Pure care</div>
        <div className="arch">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/clinic.png" alt="樸原健康診所暖色調接待空間" />
        </div>
        <h2>細緻的服務，<br />從每個小地方開始。</h2>
        <p className="muted">PURE IN APPOINTMENT SYSTEM</p>
      </div>
      <div className="loginform">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand" src="/brand/logo.svg" alt="PURE IN 樸原健康診所" />
        <div className="eyebrow">Welcome back</div>
        <h1>歡迎回來</h1>
        <p className="muted">登入帳號，開始今天的預約服務。</p>
        <LoginForm />
        {process.env.NODE_ENV !== "production" && (
          <p className="devnote">
            開發環境測試帳號：dev-admin、dev-sales-a、dev-sales-b（代理店長 dev-deputy 預設停用）。<br />
            密碼為環境變數 DEV_PASSWORD，未設定時為 dev-only-1234。正式環境不會建立這些帳號。
          </p>
        )}
      </div>
    </main>
  );
}
