#!/usr/bin/env node
/**
 * 資料庫指令（讀 DATABASE_URL，可放在 .env.local）：
 *   node scripts/db.mjs migrate    依序套用 supabase/migrations/*.sql（已套用的跳過）
 *   node scripts/db.mjs seed-dev   建立開發用測試帳號（正式環境、遠端資料庫拒絕執行）
 *   node scripts/db.mjs reset      清空本機資料庫後 migrate + seed-dev（只允許 localhost）
 *   node scripts/db.mjs create-admin [--login 帳號] [--name 顯示名稱]
 *                                  正式環境初始化：建立第一位店長（密碼由執行者輸入，不寫死；已有店長即拒絕）
 *   node scripts/db.mjs setup      正式環境第一次設定：migrate ＋ 建立第一位店長（已有店長則只 migrate）
 *   node scripts/db.mjs reset-admin-password
 *                                  店長忘記密碼且沒有其他店長能重設時使用：列出店長帳號、輸入新密碼（不顯示），
 *                                  並登出該帳號所有裝置、解除登入鎖定、寫入操作紀錄
 *
 * migrate / create-admin / setup 沒有設定 DATABASE_URL 時，會在畫面上請你貼上連線字串（輸入時不顯示），
 * 並檢查格式、貼錯會說明怎麼改。
 *
 *   node scripts/db.mjs dev-setup  npm run dev 前自動執行：本機資料庫才 migrate + seed-dev，連到遠端時什麼都不做
 */
import { readdir, readFile } from "node:fs/promises";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { explainConnectError, normalizeDatabaseUrl } from "./db-url.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

let host = "";
let isLocal = false;
/** @type {import("postgres").Sql} */
let sql;
let prompter = null;
const getPrompter = () => (prompter ??= createPrompter());

/** 可以在畫面上詢問連線字串的指令（給第一次設定正式環境的人用） */
const INTERACTIVE = new Set(["migrate", "create-admin", "setup", "reset-admin-password"]);

/** 取得連線字串（環境變數，或在畫面上詢問）、連線並確認可用 */
async function connect(cmd) {
  let parsed = null;
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) {
    parsed = normalizeDatabaseUrl(fromEnv);
    if ("error" in parsed) {
      console.error(`環境變數 DATABASE_URL 的內容不正確：${parsed.error}`);
      if (!INTERACTIVE.has(cmd)) process.exit(1);
      console.error("（以下改為直接輸入；也可以先執行 unset DATABASE_URL 清掉它。）\n");
      parsed = null;
    }
  } else if (!INTERACTIVE.has(cmd)) {
    console.error("缺少 DATABASE_URL（可寫在 .env.local）。");
    process.exit(1);
  }
  for (let attempt = 1; !parsed; attempt++) {
    if (attempt === 1) {
      console.log("請貼上 Supabase「Session pooler」的連線字串（postgresql:// 開頭的一整行），然後按 Enter。");
      console.log("為了安全，貼上時畫面不會顯示任何字，這是正常的。\n");
    }
    const r = normalizeDatabaseUrl(await getPrompter().ask("連線字串：", { hidden: true }));
    if ("error" in r) {
      console.error(`✗ ${r.error}\n`);
      if (attempt >= 3) process.exit(1);
      continue;
    }
    parsed = r;
  }
  host = parsed.host;
  isLocal = ["localhost", "127.0.0.1", "::1"].includes(host);
  sql = postgres(parsed.url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 15 });
  try {
    await sql`select 1`;
  } catch (e) {
    console.error(`✗ ${explainConnectError(e)}`);
    process.exit(1);
  }
  if (!isLocal) console.log(`✓ 已連線：${host}（使用者 ${parsed.user}）`);
}

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
  const p = getPrompter();
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
    // 提示器在程式結束時統一關閉
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

/** 店長忘記密碼的救援：能連上正式資料庫的人才能執行，等同於管理者權限 */
async function resetAdminPassword() {
  const admins = await sql`select id, login_name, display_name, active from user_accounts where role = 'admin' order by created_at`;
  if (admins.length === 0) {
    console.error("目前沒有店長帳號，請改用 npm run db:setup 建立第一位店長。");
    process.exitCode = 1;
    return;
  }
  console.log("\n店長帳號：");
  for (const a of admins) console.log(`  ${a.login_name}（${a.display_name}）${a.active ? "" : "　※ 已停用"}`);
  console.log("");
  const p = getPrompter();
  const loginName = (await p.ask("要重設哪一個登入帳號：")).trim();
  const target = admins.find((a) => a.login_name.toLowerCase() === loginName.toLowerCase());
  if (!target) throw new Error("找不到這個店長帳號（只能重設上面列出的店長）。");
  const password = await p.ask(`新密碼（至少 ${MIN_PASSWORD} 個字元，輸入時不顯示）：`, { hidden: true });
  if (password.length < MIN_PASSWORD) throw new Error(`密碼至少 ${MIN_PASSWORD} 個字元。`);
  if (password.toLowerCase().includes(target.login_name.toLowerCase()) || password === "dev-only-1234") throw new Error("密碼不可包含帳號，也不可使用開發用預設密碼。");
  const again = await p.ask("再輸入一次新密碼：", { hidden: true });
  if (again !== password) throw new Error("兩次輸入的密碼不一致。");

  await sql.begin(async (tx) => {
    await tx`update user_accounts set password_hash = ${hashPassword(password)}, active = true, updated_at = now() where id = ${target.id}`;
    await tx`delete from sessions where user_id = ${target.id}`; // 其他裝置上的登入一律失效
    await tx`delete from login_failures where login_key = ${target.login_name.toLowerCase()}`; // 解除「失敗 5 次鎖 10 分鐘」
    // 不記錄密碼或雜湊；actor 為空代表由指令執行
    await tx`
      insert into audit_logs (entity_type, entity_id, actor_user_id, action, changes)
      values ('account', ${target.id}, null, 'reset-password', ${tx.json({ name: target.display_name, via: "command" })})`;
  });
  console.log(`\n✓ 已重設「${target.display_name}」（帳號 ${target.login_name}）的密碼${target.active ? "" : "，並重新啟用帳號"}。請用新密碼登入。`);
}

/** 正式環境第一次設定：建立資料表，還沒有店長就接著建立 */
async function setup() {
  await migrate();
  const [{ n }] = await sql`select count(*)::int as n from user_accounts where role = 'admin'`;
  if (n > 0) {
    console.log("已有店長帳號，略過建立店長。");
    return;
  }
  console.log("");
  await createAdmin([]);
  if (!process.exitCode) {
    console.log("\n✓ 資料庫設定完成。下一步：設定 Resend 寄信、建立 Vercel 專案（docs/部署與維運.md「一、上線」第 3、4 步）。");
  }
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
  if (!["migrate", "seed-dev", "reset", "create-admin", "setup", "reset-admin-password", "dev-setup"].includes(cmd)) {
    console.error("用法：node scripts/db.mjs <migrate|seed-dev|reset|create-admin|setup|reset-admin-password|dev-setup>");
    process.exit(1);
  }
  await connect(cmd);
  if (cmd === "migrate") await migrate();
  else if (cmd === "seed-dev") await seedDev();
  else if (cmd === "reset") await reset();
  else if (cmd === "create-admin") await createAdmin(process.argv.slice(3));
  else if (cmd === "setup") await setup();
  else if (cmd === "reset-admin-password") await resetAdminPassword();
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
  prompter?.close();
  await sql?.end();
}
