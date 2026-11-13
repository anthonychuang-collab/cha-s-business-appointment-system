import "server-only";
/**
 * 寄信方式：
 * - 有 RESEND_API_KEY 與 NOTIFY_FROM → Resend
 * - 開發環境沒設定 → 印在終端機（不真的寄出）
 * - 正式環境沒設定 → 不寄，通知清單顯示「尚未設定寄信」
 */

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** 同一封信重試時帶相同的值，Resend 不會重複寄出 */
  idempotencyKey: string;
}

export type SendResult =
  | { ok: true; messageId: string }
  /** permanent：重試也不會成功（金鑰錯、寄件網域未驗證、收件地址格式錯…） */
  | { ok: false; error: string; permanent: boolean };

export interface MailTransport {
  name: string;
  send(mail: OutgoingEmail): Promise<SendResult>;
}

const TIMEOUT_MS = 15_000;

export function resendTransport(apiKey: string, from: string, apiUrl = process.env.RESEND_API_URL ?? "https://api.resend.com"): MailTransport {
  return {
    name: "resend",
    async send(mail) {
      let res: Response;
      try {
        res = await fetch(`${apiUrl.replace(/\/+$/, "")}/emails`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": mail.idempotencyKey },
          body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        return { ok: false, error: timeout ? "Resend 逾時" : `無法連線 Resend：${e instanceof Error ? e.message : String(e)}`, permanent: false };
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (res.ok && body.id) return { ok: true, messageId: body.id };
      const error = `Resend ${res.status}${body.message ? `：${body.message}` : ""}`.slice(0, 500);
      // 429 太頻繁、409 同一封信另一個請求處理中、5xx 對方故障 → 稍後重試；其他 4xx 視為設定錯誤
      const transient = res.status === 429 || res.status === 409 || res.status >= 500 || res.ok;
      return { ok: false, error, permanent: !transient };
    },
  };
}

export const consoleTransport: MailTransport = {
  name: "console",
  async send(mail) {
    console.log(`[開發用寄信] 收件：${mail.to.join(", ")}｜主旨：${mail.subject}`);
    return { ok: true, messageId: "console" };
  },
};

const g = globalThis as unknown as { __clinicMailOverride?: MailTransport | null };

/** 測試用：換成假的寄信方式；傳 null 恢復 */
export function setMailTransportForTests(t: MailTransport | null): void {
  g.__clinicMailOverride = t;
}

/** 回傳 null 代表正式環境尚未設定寄信 */
export function getMailTransport(): MailTransport | null {
  if (g.__clinicMailOverride) return g.__clinicMailOverride;
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM;
  if (key && from) return resendTransport(key, from);
  return process.env.NODE_ENV === "production" ? null : consoleTransport;
}
