/** 正式環境初始化指令（scripts/db.mjs create-admin）：第一位店長 */
import { spawn } from "node:child_process";
import path from "node:path";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { resetTestDatabase, TEST_URL as url } from "./helpers";

const SCRIPT = path.resolve(__dirname, "../../scripts/db.mjs");

/** 以管線送入各行輸入（非終端機模式），回傳結束碼與輸出 */
function run(args: string[], stdin: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "create-admin", ...args], {
      env: { ...process.env, DATABASE_URL: url!, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(stdin);
  });
}

describe.skipIf(!url)("create-admin 初始化指令（TEST_DATABASE_URL）", () => {
  let raw: postgres.Sql;
  const PW = "Clinic-Owner-2026";

  beforeAll(async () => {
    raw = await resetTestDatabase();
  });
  afterAll(async () => {
    await raw?.end();
  });

  const admins = async () => raw`select login_name, display_name, password_hash, active from user_accounts where role = 'admin'`;

  it("密碼不接受參數", async () => {
    const r = await run(["--login", "owner", "--password", PW], "");
    expect(r.code).toBe(1);
    expect(r.out).toContain("密碼不接受參數");
    expect(await admins()).toHaveLength(0);
  });

  it("輸入不合格時不建立任何資料", async () => {
    for (const [args, stdin, msg] of [
      [[], "x\n", "登入帳號需為"],
      [["--login", "owner"], "店長\nshort\nshort\n", "至少 10 個字元"],
      [["--login", "owner", "--name", "店長"], "owner-password-1\nowner-password-1\n", "不可包含帳號"],
      [["--login", "boss", "--name", "店長"], "dev-only-1234\ndev-only-1234\n", "開發用預設密碼"],
      [["--login", "boss", "--name", "店長"], `${PW}\nsomething-else\n`, "不一致"],
      [["--login", "boss", "--name", "店長"], `${PW}\n`, "輸入中斷"],
    ] as [string[], string, string][]) {
      const r = await run(args, stdin);
      expect(r.code, msg).toBe(1);
      expect(r.out).toContain(msg);
    }
    expect(await admins()).toHaveLength(0);
  });

  it("建立第一位店長：密碼以雜湊保存可驗證，並寫入操作紀錄", async () => {
    const r = await run([], `owner.lin\n林店長\n${PW}\n${PW}\n`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(PW);
    const [a] = await admins();
    expect(a).toMatchObject({ login_name: "owner.lin", display_name: "林店長", active: true });
    expect(a.password_hash).not.toContain(PW);
    expect(verifyPassword(PW, a.password_hash)).toBe(true);
    const [log] = await raw`select action, actor_user_id, changes from audit_logs where action = 'bootstrap-admin'`;
    expect(log.actor_user_id).toBeNull();
    expect(JSON.stringify(log.changes)).not.toContain(PW);
  });

  it("已有店長後再執行：拒絕，不建立第二位", async () => {
    const r = await run(["--login", "second", "--name", "第二位"], `${PW}x\n${PW}x\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("已有店長帳號");
    expect(await admins()).toHaveLength(1);
  });

  it("兩人同時對空資料庫執行：只會建立一位", async () => {
    await raw`delete from audit_logs`;
    await raw`delete from user_accounts`;
    const results = await Promise.all(
      ["owner.a", "owner.b", "owner.c"].map((login) => run(["--login", login, "--name", login], `${PW}\n${PW}\n`)),
    );
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(await admins()).toHaveLength(1);
  });
});
