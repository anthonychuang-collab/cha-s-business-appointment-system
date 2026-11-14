/**
 * 程式需要的最新 migration。新增 supabase/migrations 檔案時一併更新
 * （src/lib/data/schema-version.test.ts 會檢查兩者一致）。
 * /api/health 用它判斷正式資料庫是否已執行 npm run db:migrate。
 */
export const EXPECTED_MIGRATION = "20261114000000_appointment_item_ids.sql";
