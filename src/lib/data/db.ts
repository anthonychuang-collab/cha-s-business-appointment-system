import "server-only";
/**
 * PostgreSQL（Supabase）連線。只在伺服器端使用。
 *
 * - Supabase 請用 Transaction pooler（port 6543）連線字串：該模式不支援 prepared statement，
 *   所以 prepare: false；也不支援 session 層級鎖，鎖一律用 pg_advisory_xact_lock（交易結束自動釋放）。
 * - date 欄位維持 "YYYY-MM-DD" 字串，不轉成 JS Date，避免主機時區（Vercel 為 UTC）造成日期偏移。
 */
import postgres from "postgres";

export type Sql = postgres.Sql;
/** 一般連線或交易內連線都可以執行查詢 */
export type Q = postgres.Sql | postgres.TransactionSql;

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL：請設定 Supabase 連線字串（本機開發見 README）。");
  return postgres(url, {
    // 連到 Supabase 一律加密（連線字串忘了加 ?sslmode=require 也一樣）
    ...(isSupabase(url) && !/[?&]sslmode=/.test(url) ? { ssl: "require" as const } : {}),
    prepare: false,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    onnotice: () => {},
    types: {
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
}

function isSupabase(url: string): boolean {
  try {
    return /\.supabase\.(com|co)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const g = globalThis as unknown as { __clinicSql?: Sql };

/** 共用連線池（開發模式熱重載時沿用同一個，避免連線數爆增） */
export function sql(): Sql {
  return (g.__clinicSql ??= connect());
}

/** 包成一個資料庫交易；fn 丟出錯誤即整筆回滾 */
export function withTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql().begin(fn) as Promise<T>;
}

/** 測試結束時關閉連線池 */
export async function closeSql(): Promise<void> {
  const s = g.__clinicSql;
  g.__clinicSql = undefined;
  await s?.end({ timeout: 5 });
}
