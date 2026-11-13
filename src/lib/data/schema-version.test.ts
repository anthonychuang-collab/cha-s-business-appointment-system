import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_MIGRATION } from "./schema-version";

describe("EXPECTED_MIGRATION", () => {
  it("等於 supabase/migrations 中最新的檔案（新增 migration 時記得更新）", () => {
    const files = readdirSync(path.resolve(import.meta.dirname, "../../../supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(EXPECTED_MIGRATION).toBe(files.at(-1));
  });
});
