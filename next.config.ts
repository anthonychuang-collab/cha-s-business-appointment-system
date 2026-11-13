import type { NextConfig } from "next";

/**
 * 這是登入後才能用的內部系統，每個頁面都依登入身分即時讀取資料，
 * 不需要預先產生靜態頁面，因此關閉 Cache Components（全部動態算繪）。
 */
const nextConfig: NextConfig = {
  cacheComponents: false,
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
