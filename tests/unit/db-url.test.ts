import { describe, expect, it } from "vitest";
// @ts-expect-error 純 JavaScript 指令檔，沒有型別宣告
import { explainConnectError, normalizeDatabaseUrl } from "../../scripts/db-url.mjs";

const OK = "postgresql://postgres.abcdefgh:Secret123@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres";

describe("normalizeDatabaseUrl：使用者貼上的連線字串", () => {
  it("正確的 Supabase 連線字串：自動補 sslmode=require，去掉前後空白與引號", () => {
    const r = normalizeDatabaseUrl(`  "${OK}"  `);
    expect(r).toEqual({
      url: `${OK}?sslmode=require`, host: "aws-1-ap-northeast-1.pooler.supabase.com", port: "5432", user: "postgres.abcdefgh",
    });
    expect(normalizeDatabaseUrl(`${OK}?sslmode=require`).url).toBe(`${OK}?sslmode=require`);
  });

  it("本機連線字串不加 sslmode", () => {
    expect(normalizeDatabaseUrl("postgres://clinic:clinic@localhost:5432/clinic").url).toBe("postgres://clinic:clinic@localhost:5432/clinic");
  });

  it("貼成參數格式（多行或單行 host=）", () => {
    const multi = "host=aws-1-ap-northeast-1.pooler.supabase.com\nport=5432\ndatabase=postgres\nuser=postgres.abcdefgh";
    expect(normalizeDatabaseUrl(multi).error).toContain("參數格式");
    expect(normalizeDatabaseUrl("host=aws-1-ap-northeast-1.pooler.supabase.com").error).toContain("參數格式");
  });

  it("貼成指令", () => {
    expect(normalizeDatabaseUrl('echo "${DATABASE_URL#*@}"').error).toContain("指令");
    expect(normalizeDatabaseUrl("npm run db:migrate").error).toContain("指令");
  });

  it("忘了換 [YOUR-PASSWORD]、空白、沒有密碼、開頭不對", () => {
    expect(normalizeDatabaseUrl(OK.replace("Secret123", "[YOUR-PASSWORD]")).error).toContain("YOUR-PASSWORD");
    expect(normalizeDatabaseUrl("   ").error).toContain("沒有收到");
    expect(normalizeDatabaseUrl(OK.replace(":Secret123", "")).error).toContain("沒有密碼");
    expect(normalizeDatabaseUrl("aws-1-ap-northeast-1.pooler.supabase.com:5432").error).toContain("postgresql://");
  });

  it("錯誤訊息不會把密碼印出來", () => {
    for (const bad of [OK.replace("postgresql", "postgresq"), `${OK}\nport=5432`]) {
      expect(JSON.stringify(normalizeDatabaseUrl(bad))).not.toContain("Secret123");
    }
  });
});

describe("explainConnectError", () => {
  it("把常見連線錯誤轉成中文說明", () => {
    expect(explainConnectError({ code: "28P01", message: "password authentication failed for user" })).toContain("密碼錯誤");
    expect(explainConnectError({ code: "XX000", message: "Tenant or user not found" })).toContain("使用者名稱不對");
    expect(explainConnectError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND x" })).toContain("找不到資料庫主機");
    expect(explainConnectError({ code: "ETIMEDOUT", message: "timeout" })).toContain("連不上資料庫");
  });
});
