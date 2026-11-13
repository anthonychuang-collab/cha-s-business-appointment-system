import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // server-only 在 Next.js 以外 import 會丟錯；測試環境換成空模組
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/integration/**/*.test.ts"],
    // 資料庫整合測試共用同一個測試資料庫，不可平行跑檔案
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
