/**
 * 檢查並整理使用者貼上的資料庫連線字串，貼錯時回傳看得懂的中文說明。
 * 常見錯誤：貼成 Supabase 的「參數格式」（host=… 多行）、忘了換掉 [YOUR-PASSWORD]、
 * 貼成指令、密碼含特殊符號。Supabase 的連線自動補上 sslmode=require。
 */
export const SUPABASE_HINT =
  "請到 Supabase 專案上方按「Connect」，在 Session pooler（port 5432）那一區把顯示方式選成「URI」，" +
  "複製 postgresql:// 開頭的那一整行，並把 [YOUR-PASSWORD] 換成資料庫密碼。";

/** @returns {{ url: string, host: string, port: string, user: string } | { error: string }} */
export function normalizeDatabaseUrl(raw) {
  const s = String(raw ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  if (!s) return { error: "沒有收到連線字串。" };
  if (/^(host|hostaddr|user|port|database|dbname|password)\s*=/im.test(s) || /[\r\n]/.test(s)) {
    return { error: `貼上的是「參數格式」（host=… 分好幾行），需要的是 postgresql:// 開頭的一整行。${SUPABASE_HINT}` };
  }
  if (/^(npm|echo|read|export|unset|cd|git|node)\b/.test(s)) {
    return { error: "貼上的是一行指令，不是連線字串。請重新複製 postgresql:// 開頭的那一行再貼上。" };
  }
  if (/YOUR-PASSWORD/i.test(s)) return { error: "連線字串裡還是 [YOUR-PASSWORD]：請換成你的資料庫密碼（連同方括號一起換掉）。" };
  if (!/^postgres(ql)?:\/\//i.test(s)) return { error: `連線字串要以 postgresql:// 開頭。${SUPABASE_HINT}` };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "連線字串格式不正確。若密碼含有 # / ? 等符號，請到 Supabase 重設成只有英文和數字的密碼。" };
  }
  if (!u.hostname) return { error: `連線字串缺少主機名稱。${SUPABASE_HINT}` };
  const supabase = /\.supabase\.(com|co)$/i.test(u.hostname);
  if (supabase && !u.password) return { error: "連線字串裡沒有密碼：格式應為 postgresql://使用者:密碼@主機…" };
  if (supabase && !u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  return { url: u.toString(), host: u.hostname, port: u.port || "5432", user: decodeURIComponent(u.username) };
}

/** 把連線失敗轉成看得懂的說明 */
export function explainConnectError(e) {
  const code = e?.code ?? "";
  const msg = String(e?.message ?? e);
  if (code === "28P01" || /password authentication failed/i.test(msg)) {
    return "密碼錯誤：請確認連線字串裡的密碼，或到 Supabase「Project Settings → Database」重設資料庫密碼後再試。";
  }
  if (/tenant or user not found/i.test(msg)) {
    return "使用者名稱不對：Supabase pooler 的使用者應該是 postgres.專案代號（例如 postgres.abcdefgh），請重新從 Connect 視窗複製。";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "找不到資料庫主機：請確認網路連線，以及連線字串的主機名稱沒有打錯。";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT") {
    return "連不上資料庫：請確認網路連線；公司網路若擋住 5432 / 6543 port，請換個網路再試。";
  }
  return `連線失敗：${msg}`;
}
