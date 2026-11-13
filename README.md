# PURE IN 樸原健康診所｜內部預約系統（前後台頁面）

依《診所預約系統_Claude_Code開發規格.md》、《診所預約系統_PRD.md》與 PURE IN 設計素材包實作。
Next.js 16（App Router）＋ TypeScript。

## 快速開始

需要 Node.js 22 以上與一個 PostgreSQL（本機 PostgreSQL 16 或 Supabase）。

```bash
npm install
cp .env.example .env.local   # 填 DATABASE_URL（本機開發用 localhost 的資料庫）
npm run dev                  # http://localhost:3000；本機資料庫會自動 migrate 並建立測試帳號
npm test                     # 133 個核心規則單元測試（有設 TEST_DATABASE_URL 時另跑 12 個資料庫整合測試）
npm run test:db              # 讀 .env.local 的 TEST_DATABASE_URL，跑全部 145 個測試
npm run typecheck
npm run build
```

| 資料庫指令 | 說明 |
| --- | --- |
| `npm run db:migrate` | 依序套用 `supabase/migrations/*.sql`（已套用的跳過，記錄在 `app_migrations`） |
| `npm run db:seed-dev` | 建立開發用測試帳號（正式環境與遠端資料庫一律拒絕） |
| `npm run db:reset` | 清空**本機**資料庫後重建（e2e 測試前用；非 localhost 拒絕執行） |

本機資料庫開發時會自動建立測試帳號（正式環境、Supabase 都不會建立）：

| 帳號 | 角色 | 說明 |
| --- | --- | --- |
| dev-admin | 店長 | 全部功能 |
| dev-deputy | 代理店長 | 預設停用，到「帳號與權限」按「開始代理」 |
| dev-sales-a / dev-sales-b | 業務 | 各自綁定一筆業務名單 |

密碼為環境變數 `DEV_PASSWORD`，未設定時是 `dev-only-1234`。

## 頁面

| 路徑 | 角色 | 內容 |
| --- | --- | --- |
| `/login` | 全部 | 登入（失敗 5 次鎖 10 分鐘） |
| `/` | 業務 | 首頁：即將到來的預約、需處理筆數 |
| `/book` | 業務 | 四步驟預約：客戶資料 → 預約服務 → 預約時間 → 確認送出 |
| `/book/done/[id]` | 業務 | 預約完成（只限本人建立） |
| `/appointments` | 業務 | 我的預約（只看負責業務是自己）、衝突紅字、搜尋篩選 |
| `/appointments/[id]` | 業務 | 詳情；依 1 小時／4 小時／衝突規則開放修改、改期、改服務、取消 |
| `/admin` | 店長、代理 | 每日總覽：九個時段、超額、封鎖、衝突、篩選、待處理衝突清單 |
| `/admin/new` | 店長、代理 | 新增／超額加開（原因必填、醫師撞時段需確認） |
| `/admin/appointments/[id]` | 店長、代理 | 到診／未到、保留衝突、改期、修改、轉業務、取消、操作紀錄 |
| `/admin/schedule` | 店長 | 醫師、班表、請假／封鎖（先預覽受影響預約再儲存） |
| `/admin/options` | 店長 | 項目（新增、改名、排序、停用、刪除）、營業時間、最遠天數、通知設定 |
| `/admin/users` | 店長 | 帳號、停用（會踢出登入）、重設密碼、業務離職轉出、代理啟停、最後店長保護 |
| `/admin/notifications` | 店長、代理 | 通知清單 |

## 程式結構

```
src/lib/domain/     核心規則（純函式＋單元測試，不碰資料庫）
src/lib/booking.ts  預約服務層：所有預約讀寫都經過這裡，規則交給 domain
src/lib/admin.ts    設定與帳號管理；班表類一律 預覽 → 儲存 → 重算衝突
src/lib/auth/       scrypt 密碼雜湊、HttpOnly session（資料庫只存 token 雜湊）、角色檢查、登入失敗鎖定
src/lib/data/       資料型別、PostgreSQL 連線（db.ts）、SQL 存取層（repo.ts，不含規則）
supabase/migrations 資料表與初始設定（RLS 全開、不給任何 policy，Supabase 公開 API 讀寫不到）
scripts/db.mjs      migrate / seed-dev / reset
tests/integration/  資料庫整合測試：同時段鎖位、冪等、版本衝突、預約編號、班表重算、登入鎖定
src/app/            頁面與 Server Actions（每個 action 都在伺服器端重新檢查角色）
tests/e2e/          Playwright 完整操作測試（python3 tests/e2e/booking_flow.py http://localhost:3000 輸出資料夾）
```

## 設計素材的套用方式

- 顏色、字體、間距、斷點全部來自素材包 `style.css`，集中在 `src/app/globals.css` 的 `:root`。
- 提案展示用的左側頁面選單、桌面／手機切換、DESIGN PREVIEW 都已移除。
- Logo 與空間照片放在 `public/brand/`。素材來自 PURE IN 官網，**正式上線前請品牌方確認使用權**。
- 字體從 Google Fonts 載入，沒有網路時會改用系統字體。

**與素材包說明不同、以開發規格為準的地方：**

- 素材包把「負責業務」下拉選單放在第一步；規格已決定負責業務就是登入者，所以只顯示文字，不提供選單。
- 素材包建議「項目對應醫師需求」由後台設定；規格是由業務在第二步自己選「是否需要醫師」，這裡沿用規格。若之後要改成依項目自動帶入，只需改第二步的元件。

## 資料庫（Supabase）

資料存在 PostgreSQL。程式只透過伺服器端的資料庫連線字串存取，不使用 Supabase 的 JS SDK、anon key 或 Auth。

### 建立 Supabase 專案

1. 建立專案，區域選 **Northeast Asia (Tokyo)**；方案建議 Pro（每日自動備份、不會閒置暫停）。
2. Project Settings → Database → Connection string，複製 **Transaction pooler**（port 6543）的連線字串，結尾加上 `?sslmode=require`，填進 `.env.local`（或 Vercel 環境變數）的 `DATABASE_URL`。
3. 執行 `npm run db:migrate` 建立資料表與初始設定（項目、醫師班表、營業時間、通知方式）。
4. 第一位店長請用一次性初始化指令建立（下一步工作 2，尚未完成）。**不要對 Supabase 執行 `db:seed-dev`**（程式也會拒絕）。

### 並行與交易

- `booking.ts` 每個寫入函式都是一個交易；取鎖順序固定（班表鎖 → 冪等鍵 → 預約列 `FOR UPDATE` → 時段鎖 `pg_advisory_xact_lock(hashtext(date || start))` → 當日編號鎖），避免死結。
- 班表、營業時間、封鎖異動與業務離職轉出取**班表獨占鎖**，其餘預約寫入取共用鎖：重算衝突時不會有預約同時寫入而漏算。
- 鎖全部是交易層級，適用 Supabase transaction pooler；連線設定 `prepare: false`。
- 修改一律比對版本號，兩人同時改同一筆時後到者收到「此預約已被更新」。
- `tests/integration/booking.db.test.ts` 以真實資料庫驗證上述行為（10 人同時搶同一時段只成功 1 筆等）。

### 備註

- 規格第 8 節的 `schedule_rules` 依程式型別拆成 `opening_rules`（營業時間）與 `schedule_blocks`（封鎖／請假），語意不變。
- 預約日期與時段以台北本地 `date` / `time` 保存；稽核、通知、session 用 `timestamptz`。

## 尚未完成

- Email 寄送（Resend）與每日 21:00 日報排程。目前所有事件只出現在後台「通知」，`booking.ts` 的 `notify()` 留有 TODO。
- 操作紀錄的獨立查詢頁（目前只在預約詳情顯示該筆的紀錄）。
- 正式環境的備份與還原。

## 已驗證

- `npm test`：133 個核心規則測試全部通過；接上測試資料庫時 12 個整合測試也全部通過（共 145）。
- `tests/e2e/booking_flow.py`：接 PostgreSQL 後以桌面 1280px 與手機 390px 實際操作，20 項檢查全部通過，包括：
  - 錯誤帳密的提示，業務直接輸入 `/admin` 會被導回首頁。
  - 欄位錯誤顯示，上一步返回時資料保留。
  - 週二需醫師時 13:00 前不能選，選時段後顯示安排醫師。
  - 同一時段被業務 B 看到「已額滿」，業務 B 用網址也看不到業務 A 的預約。
  - 同一支電話用 +886 寫法也會跳出重複警告。
  - 醫師請假前先預覽受影響預約，儲存後店長總覽與業務手機版都顯示衝突。
  - 業務把預約改成僅護理師後，衝突自動解除。
