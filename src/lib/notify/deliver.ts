import "server-only";
/**
 * 即時信寄送（outbox）：
 * 1. booking.ts 在預約交易內寫入通知（email_next_attempt_at = now）
 * 2. 交易提交後以 after() 在回應送出後呼叫 deliverPendingEmails()，不拖慢、也不影響預約結果
 * 3. 失敗依 EMAIL_BACKOFF_MIN 延後重試；到期的重試由下列任一時機處理：
 *    之後任何一筆即時信、登入後的頁面瀏覽（每台伺服器每分鐘最多一次，見 retryDueEmailsSoon）、每日排程
 * 4. 設定錯誤（金鑰、寄件網域、收件地址）或達到次數上限即停止，在後台通知清單顯示原因，可手動重寄
 */
import { after } from "next/server";
import { sql } from "@/lib/data/db";
import * as repo from "@/lib/data/repo";
import type { Notification } from "@/lib/data/types";
import { buildInstantEmail, type NotificationPayload } from "./email";
import { getMailTransport } from "./transport";

export const MAX_EMAIL_ATTEMPTS = 6;
const BATCH = 20;

export interface DeliveryReport {
  sent: number;
  failed: number;
  stopped: number;
}

export async function deliverPendingEmails(): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, stopped: 0 };
  const q = sql();
  const transport = getMailTransport();
  const baseUrl = process.env.APP_BASE_URL || undefined;
  let settings: repo.Ref["settings"] | null = null;

  for (let round = 0; round < 10; round++) {
    const batch = await repo.claimDueEmails(q, BATCH);
    if (batch.length === 0) break;
    settings ??= (await repo.loadRef(q)).settings; // 有信要寄才讀設定
    const actors = await repo.findUserNames(q, batch.map((n) => n.actorUserId));

    for (const n of batch) {
      const stop = async (error: string) => {
        await repo.markEmailFailed(q, n.id, error, true);
        report.stopped++;
      };
      if (!transport) { await stop("尚未設定寄信（RESEND_API_KEY、NOTIFY_FROM）"); continue; }
      if (settings.notifyEmails.length === 0) { await stop("未設定通知收件地址（設定中心）"); continue; }

      const mail = buildInstantEmail({
        event: n.event, summary: n.summary, actorName: actors.get(n.actorUserId) ?? "系統", createdAt: n.createdAt,
        appointmentId: n.appointmentId, payload: n.payload as NotificationPayload, baseUrl,
      });
      let r;
      try {
        r = await transport.send({ ...mail, to: settings.notifyEmails, idempotencyKey: `notification-${n.id}` });
      } catch (e) {
        r = { ok: false as const, error: e instanceof Error ? e.message : String(e), permanent: false };
      }

      if (r.ok) {
        await repo.markEmailSent(q, n.id, r.messageId);
        report.sent++;
      } else if (r.permanent || n.emailAttempts >= MAX_EMAIL_ATTEMPTS) {
        await stop(`${r.error}${r.permanent ? "" : `（已嘗試 ${n.emailAttempts} 次，停止重試）`}`);
      } else {
        await repo.markEmailFailed(q, n.id, r.error, false);
        report.failed++;
      }
    }
    if (batch.length < BATCH) break;
  }
  if (report.failed || report.stopped) console.error(`[寄信] 成功 ${report.sent}、稍後重試 ${report.failed}、停止 ${report.stopped}`);
  return report;
}

/**
 * 回應送出後寄信。只能在請求內（Server Action、Route Handler）呼叫；
 * 在請求外（測試、指令）呼叫時不做事，由呼叫端自行執行 deliverPendingEmails()。
 */
export function scheduleEmailDelivery(): void {
  try {
    after(async () => {
      try {
        await deliverPendingEmails();
      } catch (e) {
        // 寄信流程本身出錯（例如資料庫斷線）也不影響已完成的預約；下次觸發會再處理
        console.error("[寄信] 失敗", e);
      }
    });
  } catch {
    // 不在請求範圍內
  }
}

const g = globalThis as unknown as { __clinicLastEmailSweep?: number };

/**
 * 頁面瀏覽時順便處理到期的重試（每台伺服器每分鐘最多一次）。
 * 沒有到期的信時只是一個走索引的查詢。
 */
export function retryDueEmailsSoon(): void {
  const now = Date.now();
  if (now - (g.__clinicLastEmailSweep ?? 0) < 60_000) return;
  g.__clinicLastEmailSweep = now;
  scheduleEmailDelivery();
}

export type { Notification };
