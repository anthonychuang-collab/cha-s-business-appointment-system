# PURE IN 樸原健康診所｜內部預約系統（前後台頁面）

依《診所預約系統_Claude_Code開發規格.md》、《診所預約系統_PRD.md》與 PURE IN 設計素材包實作。
Next.js 16（App Router）＋ TypeScript。

## 快速開始

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 133 個核心規則單元測試
npm run typecheck
npm run build
```

開發環境會自動建立測試帳號（正式環境不會建立）：

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
src/lib/auth/       scrypt 密碼雜湊、HttpOnly session、角色檢查
src/lib/data/       資料型別與「開發用記憶體資料庫」
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

## 換成 Supabase（下一步，交給 Claude Code）

目前 `src/lib/data/store.ts` 是**記憶體資料庫，重啟就清空**，只供畫面驗收用。換成正式資料庫的步驟：

1. 依 `src/lib/data/types.ts` 建立 PostgreSQL 資料表（欄位已對應規格第 8 節，含 `conflict_kept_reasons`）。
2. 把 `booking.ts`、`admin.ts` 裡直接讀寫 `db.xxx` 的地方換成 SQL。標註 **TRANSACTION** 的函式必須包成一個交易，讀取時段前先取 `pg_advisory_xact_lock(hashtext(date || start))`。
3. Session、冪等請求紀錄、登入失敗次數改存資料庫（目前在記憶體）。
4. 正式環境的第一位店長請用一次性初始化指令建立，不要用預設密碼。

## 尚未完成

- 資料庫持久化（見上一段）。
- Email 寄送（Resend）與每日 21:00 日報排程。目前所有事件只出現在後台「通知」，`booking.ts` 的 `notify()` 留有 TODO。
- 操作紀錄的獨立查詢頁（目前只在預約詳情顯示該筆的紀錄）。
- 正式環境的備份與還原。

## 已驗證

- `npm test`：133 個核心規則測試全部通過。
- `tests/e2e/booking_flow.py`：以桌面 1280px 與手機 390px 實際操作，20 項檢查全部通過，包括：
  - 錯誤帳密的提示，業務直接輸入 `/admin` 會被導回首頁。
  - 欄位錯誤顯示，上一步返回時資料保留。
  - 週二需醫師時 13:00 前不能選，選時段後顯示安排醫師。
  - 同一時段被業務 B 看到「已額滿」，業務 B 用網址也看不到業務 A 的預約。
  - 同一支電話用 +886 寫法也會跳出重複警告。
  - 醫師請假前先預覽受影響預約，儲存後店長總覽與業務手機版都顯示衝突。
  - 業務把預約改成僅護理師後，衝突自動解除。
