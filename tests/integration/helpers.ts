/** 整合測試共用：清空 TEST_DATABASE_URL 並套用全部 migration */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

export const TEST_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");

export async function resetTestDatabase(): Promise<postgres.Sql> {
  const url = TEST_URL!;
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !/test/i.test(url)) {
    throw new Error("TEST_DATABASE_URL 會被清空：只接受 localhost 或名稱含 test 的資料庫。");
  }
  const raw = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  await raw.unsafe("drop schema public cascade; create schema public;");
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await raw.unsafe(readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  return raw;
}
