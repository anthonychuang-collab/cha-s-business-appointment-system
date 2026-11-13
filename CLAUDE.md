# CLAUDE.md｜PURE IN 樸原健康診所 內部預約系統

給 Claude Code 的專案說明。開始任何工作前先讀完本檔。

## 這是什麼

診所內部預約系統：業務用個人帳號替客戶預約、管理自己名下的預約；店長在後台管理全院預約、班表、設定與帳號。
目前狀態：**前後台頁面與所有預約規則已完成並通過測試，但資料存在記憶體（重啟清空），尚未接資料庫與寄信。**

## 必讀文件（依序）

1. `docs/診所預約系統_PRD.md`：要做什麼、為什麼、使用者故事與驗收標準
2. `docs/診所預約系統_Claude_Code開發規格.md`：欄位、資料表、權限、規則細節。**第 12 節是最新決策，衝突時以它為準**
3. `README.md`：頁面清單、程式結構、換成 Supabase 的步驟
4. `docs/design-kit/CLAUDE_CODE_BRIEF.md`：視覺規範（已套用於 `src/app/globals.css`）

## 常用指令

```bash
npm install
npm run dev        # 開發伺服器，會自動建立 dev-admin / dev-sales-a / dev-sales-b / dev-deputy 測試帳號
npm test           # 133 個核心規則單元測試（vitest）
npm run typecheck
npm run build
python3 tests/e2e/booking_flow.py http://localhost:3000 e2e-shots   # Playwright 完整操作測試（需先啟動 dev，且資料為全新狀態）
```

測試帳號密碼：環境變數 `DEV_PASSWORD`，未設定時為 `dev-only-1234`。正式環境（NODE_ENV=production）不會建立測試帳號。

## 架構與規則（必須遵守）

- **規則只寫在 `src/lib/domain/`**：純函式、不碰資料庫、每個檔案都有測試。改規則一律測試先行：先在 `*.test.ts` 寫會失敗的測試，再改程式，跑 `npm test` 全綠。
- **所有預約讀寫只經過 `src/lib/booking.ts`**；設定與帳號經過 `src/lib/admin.ts`。頁面與 Server Action 不直接改資料。
- **權限在伺服器端檢查**：每個 Server Action 開頭都要 `requireUser([...角色])`。業務查不到別人的預約一律回 404。
- **並行安全**：`booking.ts` 中標註 TRANSACTION 的函式，換成資料庫後必須包成一個交易，並在讀時段前取 `pg_advisory_xact_lock(hashtext(date || start))`（Supabase 連線池為 transaction 模式，不可用 session 層級鎖）。
- **時間一律台北時間**：使用 `src/lib/domain/time.ts`，不可依賴主機時區（Vercel 為 UTC）。
- **介面全部繁體中文**；顏色、字體、間距只改 `src/app/globals.css` 的 `:root` 變數。
- **不可放假資料或示範人名進正式環境**；不可在前端寫固定密碼；不可把姓名、電話、照護備註放進網址或 localStorage。

## 已知的框架注意事項

- Next.js 16：`params`、`searchParams`、`cookies()` 都要 `await`；`middleware` 已改名 `proxy`。不確定時讀 `node_modules/next/dist/docs/`。
- `next.config.ts` 關閉了 `cacheComponents`：內部系統全部動態算繪，不要打開。
- React 19 的 `<form action={...}>` 送出後會**清空欄位**。本專案表單一律用 `onSubmit` + `new FormData(form, submitter)` + `startTransition` 呼叫 action（見 `src/components/ActionForm.tsx`），新表單請照做，否則違反「錯誤不清空其他欄位」。
- 手機版的按鈕列不要用 `position: sticky` 固定在底部，會蓋住最後一排時段（測試抓到過）。

## 下一步工作（依序）

1. **接 Supabase**（東京區）：依 `src/lib/data/types.ts` 與規格第 8 節建 migration；把 `store.ts` 換成資料庫存取層；session、冪等紀錄、登入失敗次數改存資料庫；加上同時段鎖位的並行整合測試。
2. **正式環境初始化**：一次性指令建立第一位店長（密碼由執行者輸入，不寫死）。
3. **Email 通知**：用 Resend 實作 `booking.ts` 的 `notify()` 中 TODO；即時信、失敗重試；寄信失敗不影響預約。
4. **每日 21:00 日報**：Vercel Cron 呼叫受 `CRON_SECRET` 保護的 Route Handler，彙整 `mode = digest` 的通知。
5. **操作紀錄查詢頁**（僅店長）。
6. **部署**到 Vercel，撰寫備份／還原說明。

每完成一步：`npm test`、`npm run typecheck`、`npm run build` 全過，並跑一次 e2e 腳本，再進下一步。

## 待使用者提供（不阻擋開發）

週五醫師姓名、真實業務名單、代理人人選、通知收件 email 與寄信網域、Vercel／Supabase／Resend 帳號、品牌方對 Logo 與照片使用權的確認、週六營業時間（官網 17:00 vs 系統 19:00）。
