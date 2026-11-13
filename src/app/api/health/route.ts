/**
 * 部署檢查：
 * - 不帶金鑰：只回 { ok }（資料庫可連線且結構為最新），不透露任何設定
 * - 帶 Authorization: Bearer <CRON_SECRET>：另外列出各項設定是否完成（只有是／否，不含任何值）
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "@/lib/data/db";
import { EXPECTED_MIGRATION } from "@/lib/data/schema-version";

export const dynamic = "force-dynamic";

function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  let database = false;
  let schema = false;
  let admins = 0;
  let recipients = 0;
  try {
    const q = sql();
    const [r] = await q`select to_regclass('public.app_migrations') is not null as has_table`;
    database = true;
    if (r.has_table) {
      const [m] = await q`select exists(select 1 from app_migrations where name = ${EXPECTED_MIGRATION}) as ok`;
      schema = Boolean(m.ok);
    }
    if (schema) {
      admins = Number((await q`select count(*)::int as n from user_accounts where role = 'admin' and active`)[0].n);
      const [s] = await q`select jsonb_array_length(value) as n from system_settings where key = 'notify_emails'`;
      recipients = Number(s?.n ?? 0);
    }
  } catch (e) {
    console.error("[health] 資料庫檢查失敗", e);
  }
  const ok = database && schema;
  if (!authorized(request.headers.get("authorization"))) {
    return Response.json({ ok }, { status: ok ? 200 : 503 });
  }
  const checks = {
    database,
    schema_up_to_date: schema,
    expected_migration: EXPECTED_MIGRATION,
    active_admin_exists: admins > 0,
    mail_configured: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM),
    notify_recipients_set: recipients > 0,
    app_base_url_set: Boolean(process.env.APP_BASE_URL),
    cron_secret_set: true,
    node_env: process.env.NODE_ENV,
    region: process.env.VERCEL_REGION ?? null,
  };
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
