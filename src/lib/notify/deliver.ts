import "server-only";
/**
 * Email 寄送（outbox）：
 * 1. booking.ts 在預約交易內寫入通知（即時信：email_next_attempt_at = now）
 * 2. 交易提交後以 after() 在回應送出後呼叫 deliverAll()，不拖慢、也不影響預約結果
 * 3. 每日 21:00 排程（/api/cron/daily）呼叫 runDailyDigest() 把「日報」事件彙整成一封
 * 4. 失敗依 EMAIL_BACKOFF_MIN 延後重試；到期的重試由下列任一時機處理：
 *    之後任何一筆即時信、登入後的頁面瀏覽（每台伺服器每分鐘最多一次，見 retryDueEmailsSoon）、每日排程
 * 5. 設定錯誤（金鑰、寄件網域、收件地址）或達到次數上限即停止，在後台通知清單顯示原因，可手動重寄
 */
import { after } from "next/server";
import { sql, withTx, type Q } from "@/lib/data/db";
import * as repo from "@/lib/data/repo";
import type { Notification } from "@/lib/data/types";
import { toTaipei } from "@/lib/domain/time";
import { buildDigestEmail, buildInstantEmail, type EmailContent, type NotificationPayload } from "./email";
import { getMailTransport, type MailTransport, type SendResult } from "./transport";

export const MAX_EMAIL_ATTEMPTS = 6;
/** 日報時間（台北），規格決策：固定 21:00 */
export const DIGEST_HOUR = 21;
const BATCH = 20;

export interface DeliveryReport {
  sent: number;
  failed: number;
  stopped: number;
}

type Outcome = "sent" | "failed" | "stopped";

/** 寄一封並回報結果；設定問題與次數上限都視為停止 */
async function sendOne(
  transport: MailTransport | null, recipients: string[], attempts: number, idempotencyKey: string, build: () => EmailContent,
  record: { sent: (messageId: string) => Promise<void>; failed: (error: string, stop: boolean) => Promise<void> },
): Promise<Outcome> {
  if (!transport) { await record.failed("尚未設定寄信（RESEND_API_KEY、NOTIFY_FROM）", true); return "stopped"; }
  if (recipients.length === 0) { await record.failed("未設定通知收件地址（設定中心）", true); return "stopped"; }
  let r: SendResult;
  try {
    r = await transport.send({ ...build(), to: recipients, idempotencyKey });
  } catch (e) {
    r = { ok: false, error: e instanceof Error ? e.message : String(e), permanent: false };
  }
  if (r.ok) { await record.sent(r.messageId); return "sent"; }
  if (r.permanent || attempts >= MAX_EMAIL_ATTEMPTS) {
    await record.failed(`${r.error}${r.permanent ? "" : `（已嘗試 ${attempts} 次，停止重試）`}`, true);
    return "stopped";
  }
  await record.failed(r.error, false);
  return "failed";
}

/** 分批取件直到沒有到期的信 */
async function drain<T>(claim: (q: Q) => Promise<T[]>, handle: (q: Q, batch: T[], recipients: string[]) => Promise<Outcome[]>): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, stopped: 0 };
  const q = sql();
  let recipients: string[] | null = null;
  for (let round = 0; round < 10; round++) {
    const batch = await claim(q);
    if (batch.length === 0) break;
    recipients ??= (await repo.loadRef(q)).settings.notifyEmails; // 有信要寄才讀設定
    for (const o of await handle(q, batch, recipients)) report[o]++;
    if (batch.length < BATCH) break;
  }
  return report;
}

const baseUrl = () => process.env.APP_BASE_URL || undefined;

export async function deliverPendingEmails(): Promise<DeliveryReport> {
  const transport = getMailTransport();
  const report = await drain(
    (q) => repo.claimDueEmails(q, BATCH),
    async (q, batch, recipients) => {
      const actors = await repo.findUserNames(q, batch.map((n) => n.actorUserId));
      const out: Outcome[] = [];
      for (const n of batch) {
        out.push(await sendOne(transport, recipients, n.emailAttempts, `notification-${n.id}`,
          () => buildInstantEmail({
            event: n.event, summary: n.summary, actorName: actors.get(n.actorUserId) ?? "系統", createdAt: n.createdAt,
            appointmentId: n.appointmentId, payload: n.payload as NotificationPayload, baseUrl: baseUrl(),
          }),
          { sent: (id) => repo.markEmailSent(q, n.id, id), failed: (e, stop) => repo.markEmailFailed(q, n.id, e, stop) }));
      }
      return out;
    },
  );
  if (report.failed || report.stopped) console.error(`[寄信] 即時信：成功 ${report.sent}、稍後重試 ${report.failed}、停止 ${report.stopped}`);
  return report;
}

export async function deliverPendingDigests(): Promise<DeliveryReport> {
  const transport = getMailTransport();
  const report = await drain(
    (q) => repo.claimDueDigests(q, BATCH),
    async (q, batch, recipients) => {
      const out: Outcome[] = [];
      for (const d of batch) {
        const items = await repo.digestNotifications(q, d.id);
        const actors = await repo.findUserNames(q, items.map((n) => n.actorUserId));
        out.push(await sendOne(transport, recipients, d.emailAttempts, `digest-${d.date}`,
          () => buildDigestEmail({
            date: d.date, baseUrl: baseUrl(),
            items: items.map((n) => ({
              event: n.event, summary: n.summary, actorName: actors.get(n.actorUserId) ?? "系統", createdAt: n.createdAt,
              appointmentId: n.appointmentId, payload: n.payload as NotificationPayload,
            })),
          }),
          { sent: (id) => repo.markDigestSent(q, d.id, id), failed: (e, stop) => repo.markDigestFailed(q, d.id, e, stop) }));
      }
      return out;
    },
  );
  if (report.failed || report.stopped) console.error(`[寄信] 日報：成功 ${report.sent}、稍後重試 ${report.failed}、停止 ${report.stopped}`);
  return report;
}

export async function deliverAll(): Promise<{ instant: DeliveryReport; digest: DeliveryReport }> {
  return { instant: await deliverPendingEmails(), digest: await deliverPendingDigests() };
}

export type DigestRun =
  | { status: "too_early"; date: string }
  | { status: "no_events"; date: string }
  | { status: "created" | "already_created"; date: string; events: number };

/**
 * 每日日報（由排程在 21:00 後呼叫）：建立當天的日報並排入寄送。
 * - 台北時間未到 21:00 不建立（避免手動或誤設排程提早切斷當天事件）
 * - 同一天重複呼叫不會建立第二封
 * - 沒有日報事件就不建立、不寄
 */
export async function runDailyDigest(now = new Date()): Promise<DigestRun> {
  const t = toTaipei(now);
  if (t.minutes < DIGEST_HOUR * 60) return { status: "too_early", date: t.date };
  const r = await withTx((tx) => repo.createDigest(tx, t.date));
  if (!r) return { status: "no_events", date: t.date };
  return { status: r.created ? "created" : "already_created", date: t.date, events: r.digest.eventCount };
}

/**
 * 回應送出後寄信。只能在請求內（Server Action、Route Handler、Server Component）呼叫；
 * 在請求外（測試、指令）呼叫時不做事，由呼叫端自行執行 deliverAll()。
 */
export function scheduleEmailDelivery(): void {
  try {
    after(async () => {
      try {
        await deliverAll();
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
 * 沒有到期的信時只是兩個走索引的查詢。
 */
export function retryDueEmailsSoon(): void {
  const now = Date.now();
  if (now - (g.__clinicLastEmailSweep ?? 0) < 60_000) return;
  g.__clinicLastEmailSweep = now;
  scheduleEmailDelivery();
}

export type { Notification };
