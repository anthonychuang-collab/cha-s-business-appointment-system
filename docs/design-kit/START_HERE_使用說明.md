# PURE IN 預約系統設計素材包

## 如何交給 Claude Code
1. 解壓縮整個資料夾，放入你的程式專案。
2. 請 Claude Code 先讀 `CLAUDE_CODE_BRIEF.md`，再讀 `prototype/style.css`、`prototype/app.js`。
3. 圖片在 `images/`；可操作的全部頁面在 `prototype/`。開啟 `prototype/index.html` 可瀏覽所有頁面，也可開啟編號頁面。

## 包含內容
- 實際用於這次提案的全部圖片素材：`clinic.png` 診所空間照片、`logo.svg` 品牌向量標誌，共 2 個不同素材。
- 完整 HTML / CSS / JavaScript 互動樣式原始碼。
- 14 個編號頁面入口（含風格研究與 13 個系統頁面）。
- Claude Code 開發交接說明與圖片來源清單。

這包沒有另外製作頁面截圖。各頁面是可開啟的 HTML 設計參考，能讓 Claude Code 直接取得準確色碼、間距、字體與互動結構，比僅靠圖片還原更完整。圖示與圓弧等大部分裝飾是 CSS 或文字，不是獨立圖片。

字體透過 Google Fonts 載入，需連線；未連線會使用系統替代字體。可用 `python3 -m http.server 8000 --directory prototype` 在本機預覽。

此為設計原型，不是正式預約系統；資料與帳號都是示範，重新整理會重置。後台儲存與登入未串接。上一版因瀏覽器連線異常，尚未完成瀏覽器視覺驗收。
