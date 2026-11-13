#!/usr/bin/env node
/**
 * 資料庫指令（讀 DATABASE_URL，可放在 .env.local）：
 *   node scripts/db.mjs migrate    依序套用 supabase/migrations/*.sql（已套用的跳過）
 *   node scripts/db.mjs seed-dev   建立開發用測試帳號（正式環境、遠端資料庫拒絕執行）
 *   node scripts/db.mjs reset      清空本機資料庫後 migrate + seed-dev（只允許 localhost）
 *   node scripts/db.mjs dev-setup  npm run dev 前自動執行：本機資料庫才 migrate + seed-dev，連到遠端時什麼都不做
 */
import { readdir, readFile } from "node:fs/promises";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
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
  else if (cmd === "dev-setup") {
    if (isLocal) { await migrate(); await seedDev(); }
    else console.log(`DATABASE_URL 指向遠端（${host}）：略過自動 migrate 與測試帳號。需要時請手動執行 npm run db:migrate。`);
  }
  else {
    console.error("用法：node scripts/db.mjs <migrate|seed-dev|reset|dev-setup>");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
