/** /api/health：公開只回 ok；帶 CRON_SECRET 才列出設定狀態（只有是／否） */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetTestDatabase, TEST_URL as url } from "./helpers";

if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)("/api/health（TEST_DATABASE_URL）", () => {
  let raw: postgres.Sql;
  let route: typeof import("@/app/api/health/route");
  let dbm: typeof import("@/lib/data/db");
  const call = (auth?: string) => route.GET(new Request("http://localhost/api/health", { headers: auth ? { authorization: auth } : {} }));

  beforeAll(async () => {
    raw = await resetTestDatabase();
    // resetTestDatabase 直接套 SQL，不經 scripts/db.mjs：補上 migration 紀錄
    await raw`create table app_migrations (name text primary key, applied_at timestamptz not null default now())`;
    [route, dbm] = await Promise.all([import("@/app/api/health/route"), import("@/lib/data/db")]);
    process.env.CRON_SECRET = "health-secret";
    process.env.RESEND_API_KEY = "re_x";
    process.env.NOTIFY_FROM = "a@example.com";
  });
  afterAll(async () => {
    for (const k of ["CRON_SECRET", "RESEND_API_KEY", "NOTIFY_FROM"]) delete process.env[k];
    await dbm?.closeSql();
    await raw?.end();
  });

  it("資料庫結構未更新：503，公開回應只有 ok", async () => {
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("結構為最新：200；帶錯金鑰仍只回 ok", async () => {
    const { EXPECTED_MIGRATION } = await import("@/lib/data/schema-version");
    await raw`insert into app_migrations (name) values (${EXPECTED_MIGRATION})`;
    expect(await (await call()).json()).toEqual({ ok: true });
    expect(await (await call("Bearer wrong")).json()).toEqual({ ok: true });
  });

  it("帶正確金鑰：列出設定狀態，不含任何設定值", async () => {
    const res = await call("Bearer health-secret");
    const body = await res.json();
    expect(body.checks).toMatchObject({
      database: true, schema_up_to_date: true, active_admin_exists: false, mail_configured: true, notify_recipients_set: false, cron_secret_set: true,
    });
    const text = JSON.stringify(body);
    for (const secret of ["health-secret", "re_x", "a@example.com", url!]) expect(text).not.toContain(secret);
  });
});
