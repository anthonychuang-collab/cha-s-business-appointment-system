/** DATABASE_URL 格式錯誤時，錯誤訊息不可包含原字串（會進到雲端平台的紀錄，洩漏密碼） */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("DATABASE_URL 用了 Supabase Transaction pooler", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    process.env.DATABASE_URL = original;
    vi.resetModules();
  });

  it("拒絕 port 6543，並提示改用 Session pooler；錯誤訊息不含密碼", async () => {
    process.env.DATABASE_URL = "postgresql://postgres.abcdefgh:SuperSecretPw123@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres";
    vi.resetModules();
    const { sql } = await import("@/lib/data/db");
    expect(() => sql()).toThrow(/Session pooler（port 5432）/);
    try { sql(); } catch (e) { expect(String(e)).not.toContain("SuperSecretPw123"); }
  });

  it("Session pooler（5432）可以建立連線池", async () => {
    process.env.DATABASE_URL = "postgresql://postgres.abcdefgh:pw@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres";
    vi.resetModules();
    const { sql, closeSql } = await import("@/lib/data/db");
    expect(() => sql()).not.toThrow(); // 只建立連線池，不會真的連線
    await closeSql();
  });
});

describe("DATABASE_URL 格式錯誤", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    process.env.DATABASE_URL = original;
    vi.resetModules();
  });

  for (const bad of [
    "Supabase Transaction pooler (port 6543) 那條，SuperSecretPw123",
    "host=aws-1.pooler.supabase.com\nuser=postgres.x\npassword=SuperSecretPw123",
    "https://user:SuperSecretPw123@example.com",
  ]) {
    it(`不洩漏內容：${bad.slice(0, 30)}…`, async () => {
      process.env.DATABASE_URL = bad;
      vi.resetModules();
      const { sql } = await import("@/lib/data/db");
      let message = "";
      try {
        sql();
      } catch (e) {
        message = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ""}`;
      }
      expect(message).toContain("DATABASE_URL 格式不正確");
      expect(message).not.toContain("SuperSecretPw123");
    });
  }
});
