import "server-only";
/**
 * PostgreSQL（Supabase）連線。只在伺服器端使用。
 *
 * - Supabase 請用 **Session pooler（port 5432）** 連線字串，不要用 Transaction pooler（6543）：
 *   本程式會在同一條連線上連續送出多個查詢（例如同時讀取醫師、班表、設定），
 *   正式環境實測 Transaction pooler 會把回應配錯查詢，接著連線卡住直到逾時；Session pooler 則不會。
 *   使用 6543 時直接拒絕連線，避免讀到錯的資料。
 * - 鎖一律用 pg_advisory_xact_lock（交易結束自動釋放），兩種連線池都適用。
 * - date 欄位維持 "YYYY-MM-DD" 字串，不轉成 JS Date，避免主機時區（Vercel 為 UTC）造成日期偏移。
 */
import postgres from "postgres";

export type Sql = postgres.Sql;
/** 一般連線或交易內連線都可以執行查詢 */
export type Q = postgres.Sql | postgres.TransactionSql;

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL：請設定 Supabase 連線字串（本機開發見 README）。");
  // 格式錯誤時不可把原字串放進錯誤訊息：它含有資料庫密碼，會被寫進 Vercel 等平台的紀錄
  if (!isValidDatabaseUrl(url)) {
    throw new Error("DATABASE_URL 格式不正確：需要 postgresql:// 開頭的一整行連線字串（為保護密碼，這裡不顯示內容）。");
  }
  if (isSupabaseTransactionPooler(url)) {
    throw new Error("DATABASE_URL 使用了 Supabase Transaction pooler（port 6543），會讓查詢結果錯亂。請改用 Session pooler（port 5432）的連線字串。");
  }
  return postgres(url, {
    // 連到 Supabase 一律加密（連線字串忘了加 ?sslmode=require 也一樣）
    ...(isSupabase(url) && !/[?&]sslmode=/.test(url) ? { ssl: "require" as const } : {}),
    prepare: false,
    // Session pooler 每條連線都占用一個資料庫連線，保持少量即可
    max: Number(process.env.DATABASE_POOL_MAX ?? 3),
    idle_timeout: 20,
    onnotice: () => {},
    types: {
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
}

function isValidDatabaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "postgres:" || u.protocol === "postgresql:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

function isSupabaseTransactionPooler(url: string): boolean {
  const u = new URL(url);
  return /\.pooler\.supabase\.com$/i.test(u.hostname) && u.port === "6543";
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
