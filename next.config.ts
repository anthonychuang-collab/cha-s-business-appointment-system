import type { NextConfig } from "next";

/** 所有回應都加上的安全標頭（內部系統：不給搜尋引擎、不允許被嵌入其他網站） */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 網址含預約 id，不帶給其他網站
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/**
 * 這是登入後才能用的內部系統，每個頁面都依登入身分即時讀取資料，
 * 不需要預先產生靜態頁面，因此關閉 Cache Components（全部動態算繪）。
 */
const nextConfig: NextConfig = {
  cacheComponents: false,
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
