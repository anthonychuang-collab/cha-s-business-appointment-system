/**
 * 重複電話比對用的正規化（規格 5.6）。
 * 原始輸入仍需完整保存；此值只存於 phone_normalized 欄位供比對。
 */
export function normalizePhone(raw: string): string {
  // 1. 去掉分機：# / 轉 / ext（不分大小寫、可帶點）之後的所有內容
  const withoutExt = raw.split(/#|轉|ext\.?/i)[0];
  // 2. 只留數字與開頭的 +
  let s = withoutExt.trim().replace(/[^\d+]/g, "");
  // 3. +886 國碼轉回 0
  if (s.startsWith("+886")) s = "0" + s.slice(4);
  return s.replace(/\+/g, "");
}
