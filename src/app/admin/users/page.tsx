import { requireUser } from "@/lib/auth/session";
import { pageRef } from "@/lib/booking";
import { futureCountBySalesperson } from "@/lib/admin";
import { AdminHeader, Footer } from "@/components/Chrome";
import { ActionForm } from "@/components/ActionForm";
import { createAccountAction, resetPasswordAction, toggleAccountAction, transferAction } from "../actions";

const ROLE = { admin: "店長", deputy: "代理店長", sales: "業務" } as const;

export default async function UsersPage() {
  const me = await requireUser(["admin"]);
  const db = await pageRef();
  const futureBySp = await futureCountBySalesperson();
  const activeSales = db.salespeople.filter((s) => s.active);

  return (
    <>
      <AdminHeader me={me} tab="users" />
      <main className="content">
        <div className="eyebrow">People & permissions</div>
        <h1>讓對的人，做好每一件事。</h1>
        <p className="muted">業務：建立與管理自己名下的預約。代理店長：店長請假時處理預約（平常停用）。店長：全部功能。</p>

        <div className="tablewrap" style={{ marginTop: 24 }}>
          <table>
            <thead><tr><th>使用者</th><th>登入帳號</th><th>角色</th><th>狀態</th><th>操作</th></tr></thead>
            <tbody>
              {db.users.map((u) => {
                const sp = db.salespeople.find((s) => s.userAccountId === u.id);
                const future = sp ? futureBySp.get(sp.id) ?? 0 : 0;
                return (
                  <tr key={u.id}>
                    <td>{u.displayName}{u.id === me.user.id && <small>（你）</small>}</td>
                    <td>{u.loginName}</td>
                    <td>{ROLE[u.role]}{sp && <small>未來預約 {future} 筆</small>}</td>
                    <td><span className={`badge ${u.active ? "" : "gray"}`}>{u.active ? "啟用中" : "停用"}</span></td>
                    <td style={{ minWidth: 260 }}>
                      <ActionForm action={toggleAccountAction} submit={u.role === "deputy" ? (u.active ? "結束代理（停用）" : "開始代理（啟用）") : u.active ? "停用" : "啟用"} danger={u.active}>
                        <input type="hidden" name="id" value={u.id} /><input type="hidden" name="active" value={u.active ? "0" : "1"} />
                      </ActionForm>
                      {sp && future > 0 && (
                        <details className="editbox">
                          <summary>轉出未來預約</summary>
                          <div>
                            <ActionForm action={transferAction} submit={`全部轉出（${future} 筆）`}>
                              <input type="hidden" name="from" value={sp.id} />
                              <label className="field">轉給
                                <select name="to">{activeSales.filter((s) => s.id !== sp.id).map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select>
                              </label>
                            </ActionForm>
                            <p className="muted">需要逐筆轉給不同人時，請到預約詳情的「轉換負責業務」。</p>
                          </div>
                        </details>
                      )}
                      <details className="editbox">
                        <summary>重設密碼</summary>
                        <div>
                          <ActionForm action={resetPasswordAction} submit="重設">
                            <input type="hidden" name="id" value={u.id} />
                            <label className="field">新密碼<input type="password" name="password" autoComplete="new-password" minLength={10} /><small>至少 10 個字元。重設後該帳號需重新登入。</small></label>
                          </ActionForm>
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <section className="panel" style={{ marginTop: 30, maxWidth: 720 }}>
          <h3>新增帳號</h3>
          <ActionForm action={createAccountAction} submit="建立帳號">
            <div className="two">
              <label className="field">顯示名稱<input name="displayName" required /></label>
              <label className="field">登入帳號<input name="loginName" required autoComplete="off" /><small>3–30 個英數字或 . _ -</small></label>
            </div>
            <div className="two">
              <label className="field">角色
                <select name="role" defaultValue="sales"><option value="sales">業務</option><option value="deputy">代理店長（建立後為停用）</option><option value="admin">店長</option></select>
              </label>
              <label className="field">初始密碼<input type="password" name="password" autoComplete="new-password" minLength={10} required /><small>至少 10 個字元</small></label>
            </div>
            <p className="muted">建立業務帳號會同時建立同名的業務名單，作為「負責業務」。</p>
          </ActionForm>
        </section>
      </main>
      <Footer />
    </>
  );
}
