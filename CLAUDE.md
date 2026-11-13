# CLAUDE.md｜PURE IN 樸原健康診所 內部預約系統

給 Claude Code 的專案說明。開始任何工作前先讀完本檔。

## 這是什麼

診所內部預約系統：業務用個人帳號替客戶預約、管理自己名下的預約；店長在後台管理全院預約、班表、設定與帳號。
目前狀態：**前後台頁面與所有預約規則已完成並通過測試；資料已存 PostgreSQL（Supabase），並有並行整合測試。正式環境用 `npm run db:create-admin` 建立第一位店長；即時信以 Resend 寄送並自動重試；每日 21:00 日報由 Vercel Cron 觸發。**

## 必讀文件（依序）

1. `docs/診所預約系統_PRD.md`：要做什麼、為什麼、使用者故事與驗收標準
2. `docs/診所預約系統_Claude_Code開發規格.md`：欄位、資料表、權限、規則細節。**第 12 節是最新決策，衝突時以它為準**
3. `README.md`：頁面清單、程式結構、Supabase 設定與並行設計
4. `docs/design-kit/CLAUDE_CODE_BRIEF.md`：視覺規範（已套用於 `src/app/globals.css`）

## 常用指令

```bash
npm install
cp .env.example .env.local   # 填 DATABASE_URL、TEST_DATABASE_URL（本機 PostgreSQL）
npm run dev        # 開發伺服器；本機資料庫會自動 migrate 並建立 dev-admin / dev-sales-a / dev-sales-b / dev-deputy
npm test           # 148 個規則、信件與紀錄格式單元測試（設了 TEST_DATABASE_URL 時另跑資料庫整合測試）
npm run test:db    # 讀 .env.local，跑全部 193 個（含並行整合測試；會清空 TEST_DATABASE_URL）
npm run typecheck
npm run build
npm run db:reset   # 清空本機資料庫並重建（e2e 前先跑）
npm run db:create-admin   # 正式環境建立第一位店長（互動輸入密碼；已有店長即拒絕）
python3 tests/e2e/booking_flow.py http://localhost:3000 e2e-shots   # Playwright 完整操作測試（需先 db:reset 再啟動 dev）
```

測試帳號密碼：環境變數 `DEV_PASSWORD`，未設定時為 `dev-only-1234`。正式環境（NODE_ENV=production）與遠端資料庫（Supabase）一律不建立測試帳號。

## 架構與規則（必須遵守）

- **規則只寫在 `src/lib/domain/`**：純函式、不碰資料庫、每個檔案都有測試。改規則一律測試先行：先在 `*.test.ts` 寫會失敗的測試，再改程式，跑 `npm test` 全綠。
- **所有預約讀寫只經過 `src/lib/booking.ts`**；設定與帳號經過 `src/lib/admin.ts`。頁面與 Server Action 不直接改資料。SQL 只寫在 `src/lib/data/repo.ts`（不放規則）；頁面讀設定類資料用 `pageRef()`（每個請求只查一次）。
- **權限在伺服器端檢查**：每個 Server Action 開頭都要 `requireUser([...角色])`。業務查不到別人的預約一律回 404。
- **並行安全**：寫入一律在 `withTx` 交易內，取鎖順序固定：班表鎖（預約寫入共用、班表異動獨占）→ 冪等鍵 → 預約列 `FOR UPDATE` → 時段鎖 `pg_advisory_xact_lock(hashtext(date || start))` → 當日編號鎖。Supabase 連線池為 transaction 模式，只能用交易層級鎖、`prepare: false`。改動並行邏輯時先在 `tests/integration/` 加測試。
- **資料表變更**：只新增 `supabase/migrations/` 的新檔（檔名時間戳遞增），不要改已套用的舊檔；新資料表要加進 RLS 區塊。
- **時間一律台北時間**：使用 `src/lib/domain/time.ts`，不可依賴主機時區（Vercel 為 UTC）；伺服器端也不要用 `toLocaleString` 產生要比對或寄出的文字（各主機 ICU 輸出不同，例如空白字元），用 `lib/notify/email.ts` 的 `taipeiTime()`。
- **操作紀錄**：每個異動都要寫 audit_logs，`changes` 存「看得懂的內容」（名稱、時段等當下文字，或 `{ from, to }`），不存密碼、雜湊、照護備註原文。新增動作時同步在 `src/lib/audit-format.ts` 補中文名稱。只有店長能看（代理店長、業務都不行）。
- **通知與寄信**：事件一律在預約交易內呼叫 `notify()` 寫入（含寄信用的 payload），**絕不在交易內寄信**；交易提交後由 `lib/notify/deliver.ts` 寄送。信件內容只在 `lib/notify/email.ts` 產生，照護備註永遠只寫「已修改」。
- **介面全部繁體中文**；顏色、字體、間距只改 `src/app/globals.css` 的 `:root` 變數。
- **不可放假資料或示範人名進正式環境**；不可在前端寫固定密碼；不可把姓名、電話、照護備註放進網址或 localStorage。

## 已知的框架注意事項

- Next.js 16：`params`、`searchParams`、`cookies()` 都要 `await`；`middleware` 已改名 `proxy`。不確定時讀 `node_modules/next/dist/docs/`。
- `next.config.ts` 關閉了 `cacheComponents`：內部系統全部動態算繪，不要打開。
- React 19 的 `<form action={...}>` 送出後會**清空欄位**。本專案表單一律用 `onSubmit` + `new FormData(form, submitter)` + `startTransition` 呼叫 action（見 `src/components/ActionForm.tsx`），新表單請照做，否則違反「錯誤不清空其他欄位」。
- 手機版的按鈕列不要用 `position: sticky` 固定在底部，會蓋住最後一排時段（測試抓到過）。

## 下一步工作（依序）

1. ~~**接 Supabase**~~（2026-11-13 完成）：migration、`repo.ts` 存取層、session／冪等／登入失敗存資料庫、並行整合測試。順帶修正登入失敗計數永遠歸 1、永不鎖定的錯誤。
2. ~~**正式環境初始化**~~（2026-11-13 完成）：`npm run db:create-admin`，密碼只能在提示時輸入（終端機不回顯），已有店長即拒絕，同時執行也只建立一位，寫入操作紀錄。
3. ~~**Email 通知**~~（2026-11-13 完成）：outbox＋`after()` 寄送、退避重試、設定錯誤停止並可手動重寄、`SKIP LOCKED`＋Resend 冪等鍵防重複。日報要用的 `notifications.payload`（預約摘要與差異）已一併寫入。
4. ~~**每日 21:00 日報**~~（2026-11-13 完成）：`vercel.json` 排程 → `/api/cron/daily`（`CRON_SECRET`）→ `runDailyDigest()` 建立當天日報（未到 21:00 不建、沒事件不寄、一天一封）＋ `deliverAll()` 補寄重試。
5. ~~**操作紀錄查詢頁**~~（2026-11-13 完成）：`/admin/audit`（僅店長、唯讀、篩選＋分頁）。班表、項目、設定、帳號的紀錄改為記下可讀內容；代理店長在預約詳情不再看得到操作紀錄（驗收 19）。
6. **部署**到 Vercel，撰寫備份／還原說明。

每完成一步：`npm test`、`npm run typecheck`、`npm run build` 全過，並跑一次 e2e 腳本，再進下一步。

## 待使用者提供（不阻擋開發）

週五醫師姓名、真實業務名單、代理人人選、通知收件 email 與寄信網域、Vercel／Supabase／Resend 帳號、品牌方對 Logo 與照片使用權的確認、週六營業時間（官網 17:00 vs 系統 19:00）。
