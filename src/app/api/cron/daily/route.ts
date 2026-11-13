/**
 * 每日排程（Vercel Cron，vercel.json：每天 UTC 13:00 ＝ 台北 21:00）：
 * 1. 建立當天日報並寄出（沒有日報事件不寄）
 * 2. 補寄到期的即時信與日報重試
 *
 * Vercel 會自動帶 Authorization: Bearer <CRON_SECRET>。未設定 CRON_SECRET 時一律拒絕。
 * 手動觸發（例如補寄）：curl -H "Authorization: Bearer $CRON_SECRET" https://網址/api/cron/daily
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { deliverAll, runDailyDigest } from "@/lib/notify/deliver";

export const maxDuration = 60;

function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  // 先雜湊成固定長度再比較，不因長度不同而洩漏資訊
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "CRON_SECRET 未設定" }, { status: 503 });
  }
  if (!authorized(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const digest = await runDailyDigest();
  const delivery = await deliverAll();
  console.log(`[排程] 日報 ${JSON.stringify(digest)}；寄送 ${JSON.stringify(delivery)}`);
  return Response.json({ digest, delivery });
}
