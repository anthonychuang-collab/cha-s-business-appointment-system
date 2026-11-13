#!/usr/bin/env node
/**
 * 資料庫指令（讀 DATABASE_URL，可放在 .env.local）：
 *   node scripts/db.mjs migrate    依序套用 supabase/migrations/*.sql（已套用的跳過）
 *   node scripts/db.mjs seed-dev   建立開發用測試帳號（正式環境、遠端資料庫拒絕執行）
 *   node scripts/db.mjs reset      清空本機資料庫後 migrate + seed-dev（只允許 localhost）
 *   node scripts/db.mjs create-admin [--login 帳號] [--name 顯示名稱]
 *                                  正式環境初始化：建立第一位店長（密碼由執行者輸入，不寫死；已有店長即拒絕）
 *   node scripts/db.mjs dev-setup  npm run dev 前自動執行：本機資料庫才 migrate + seed-dev，連到遠端時什麼都不做
 */
import { readdir, readFile } from "node:fs/promises";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("缺少 DATABASE_URL（可寫在 .env.local）。");
  process.exit(1);
}
const host = new URL(url).hostname;
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(host);
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

async function migrate() {
  await sql`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from app_migrations`).map((r) => r.name));
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const body = await readFile(path.join(MIGRATIONS, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into app_migrations (name) values (${f})`;
    });
    console.log(`套用 ${f}`);
  }
  console.log("資料庫結構已是最新。");
}

function hashPassword(password) {
  // 與 src/lib/auth/password.ts 相同格式：salt$hash（scrypt, hex）
  const salt = randomBytes(16).toString("hex");
  return `${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

async function seedDev() {
  // 測試帳號用公開的預設密碼，絕不能進 Supabase 等遠端資料庫
  if (process.env.NODE_ENV === "production" || (!isLocal && process.env.ALLOW_REMOTE_DEV_SEED !== "1")) {
    console.error(`拒絕在正式環境或遠端資料庫（${host}）建立測試帳號。`);
    process.exit(1);
  }
  const pw = hashPassword(process.env.DEV_PASSWORD || "dev-only-1234");
  const users = [
    ["dev-admin", "開發用店長", "admin", true],
    ["dev-deputy", "開發用代理店長", "deputy", false],
    ["dev-sales-a", "開發用業務 A", "sales", true],
    ["dev-sales-b", "開發用業務 B", "sales", true],
  ];
  await sql.begin(async (tx) => {
    for (const [login, name, role, active] of users) {
      const [u] = await tx`
        insert into user_accounts (login_name, password_hash, display_name, role, active)
        values (${login}, ${pw}, ${name}, ${role}, ${active})
        on conflict (lower(login_name)) do nothing
        returning id`;
      if (u && role === "sales") {
        await tx`
          insert into salespeople (display_name, sort_order, user_account_id)
          values (${name}, (select coalesce(max(sort_order), 0) + 1 from salespeople), ${u.id})`;
      }
    }
  });
  console.log("開發用測試帳號已就緒：dev-admin / dev-deputy / dev-sales-a / dev-sales-b");
}

// ---------- 正式環境初始化：第一位店長 ----------

const LOGIN_RE = /^[a-zA-Z0-9._-]{3,30}$/; // 與 src/lib/admin.ts createAccount 相同
const MIN_PASSWORD = 10;

/** 讀取 --login x / --login=x；密碼一律不接受參數，避免留在 shell 歷史與程序清單 */
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`看不懂的參數：${argv[i]}`);
    const [, key, inline] = m;
    if (key === "password") throw new Error("為了安全，密碼不接受參數，請在提示時輸入。");
    if (!["login", "name"].includes(key)) throw new Error(`未知參數：--${key}`);
    out[key] = inline ?? argv[++i];
    if (out[key] === undefined) throw new Error(`--${key} 需要值`);
  }
  return out;
}

/**
 * 逐行讀取標準輸入。終端機上輸入密碼時不回顯；
 * 非終端機（例如以管線傳入）時依序讀取各行，方便自動化，但密碼仍不會出現在參數裡。
 */
function createPrompter() {
  const tty = Boolean(process.stdin.isTTY);
  let muted = false;
  const output = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: tty });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt, { hidden = false } = {}) {
      process.stdout.write(prompt);
      muted = hidden && tty;
      const { value, done } = await lines.next();
      muted = false;
      if (hidden || !tty) process.stdout.write("\n");
      if (done) throw new Error("輸入中斷，未建立帳號。");
      return value;
    },
    close: () => rl.close(),
  };
}

async function createAdmin(argv) {
  const flags = parseFlags(argv);
  const [{ ok }] = await sql`select to_regclass('public.user_accounts') is not null as ok`;
  if (!ok) throw new Error("資料表尚未建立，請先執行 npm run db:migrate。");

  // 先檢查一次，避免輸入完密碼才被拒絕；交易內會再確認
  const [{ n }] = await sql`select count(*)::int as n from user_accounts where role = 'admin'`;
  if (n > 0) {
    console.error("已有店長帳號，不再使用初始化指令。請以店長登入後台「帳號與權限」新增帳號或重設密碼。");
    process.exitCode = 1;
    return;
  }

  console.log(`建立第一位店長（資料庫：${host}）`);
  const p = createPrompter();
  let loginName, displayName, password;
  try {
    loginName = (flags.login ?? (await p.ask("登入帳號（3–30 個英數字或 . _ -）："))).trim();
    if (!LOGIN_RE.test(loginName)) throw new Error("登入帳號需為 3–30 個英數字或 . _ -。");
    displayName = (flags.name ?? (await p.ask("顯示名稱："))).trim();
    if (!displayName || displayName.length > 50) throw new Error("請填寫顯示名稱（50 字以內）。");
    password = await p.ask(`密碼（至少 ${MIN_PASSWORD} 個字元，輸入時不顯示）：`, { hidden: true });
    if (password.length < MIN_PASSWORD) throw new Error(`密碼至少 ${MIN_PASSWORD} 個字元。`);
    if (password.toLowerCase().includes(loginName.toLowerCase()) || password === "dev-only-1234") throw new Error("密碼不可包含帳號，也不可使用開發用預設密碼。");
    const again = await p.ask("再輸入一次密碼：", { hidden: true });
    if (again !== password) throw new Error("兩次輸入的密碼不一致。");
  } finally {
    p.close();
  }

  const created = await sql.begin(async (tx) => {
    // 兩人同時執行也只會建立一位
    await tx`select pg_advisory_xact_lock(1, hashtext('bootstrap-admin'))`;
    const [{ n }] = await tx`select count(*)::int as n from user_accounts where role = 'admin'`;
    if (n > 0) return { error: "已有店長帳號，未建立。" };
    const [dup] = await tx`select 1 from user_accounts where lower(login_name) = lower(${loginName})`;
    if (dup) return { error: "此登入帳號已存在。" };
    const [u] = await tx`
      insert into user_accounts (login_name, password_hash, display_name, role, active)
      values (${loginName}, ${hashPassword(password)}, ${displayName}, 'admin', true)
      returning id`;
    // 不記錄密碼或雜湊；actor 為空代表系統初始化
    await tx`
      insert into audit_logs (entity_type, entity_id, actor_user_id, action, changes)
      values ('account', ${u.id}, null, 'bootstrap-admin', ${tx.json({ name: displayName, loginName, role: "admin" })})`;
    return { id: u.id };
  });
  if (created.error) {
    console.error(created.error);
    process.exitCode = 1;
    return;
  }
  console.log(`已建立店長「${displayName}」（帳號 ${loginName}）。請登入後到「帳號與權限」建立其他帳號。`);
}

async function reset() {
  if (!isLocal || process.env.NODE_ENV === "production") {
    console.error(`拒絕清空非本機資料庫（${host}）。`);
    process.exit(1);
  }
  await sql.unsafe("drop schema public cascade; create schema public;");
  console.log("已清空本機資料庫。");
  await migrate();
  await seedDev();
}

const cmd = process.argv[2];
try {
  if (cmd === "migrate") await migrate();
  else if (cmd === "seed-dev") await seedDev();
  else if (cmd === "reset") await reset();
  else if (cmd === "create-admin") await createAdmin(process.argv.slice(3));
  else if (cmd === "dev-setup") {
    if (isLocal) { await migrate(); await seedDev(); }
    else console.log(`DATABASE_URL 指向遠端（${host}）：略過自動 migrate 與測試帳號。需要時請手動執行 npm run db:migrate。`);
  }
  else {
    console.error("用法：node scripts/db.mjs <migrate|seed-dev|reset|create-admin|dev-setup>");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error && !(e instanceof postgres.PostgresError) ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
