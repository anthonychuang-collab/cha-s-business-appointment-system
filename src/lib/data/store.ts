import "server-only";
/**
 * 開發用記憶體資料庫。
 * ⚠️ 只供本機開發與畫面驗收：重啟就清空，也不支援多台伺服器。
 * 正式環境請以 Supabase PostgreSQL 實作同樣的資料表（見 README「換成 Supabase」）。
 */
import { hashPassword } from "@/lib/auth/password";
import type { Db } from "./types";

function seed(): Db {
  const now = new Date().toISOString();
  const db: Db = {
    users: [],
    salespeople: [],
    // 規格 3.2 初始項目
    items: ["一般健保看診", "一般自費看診", "療程諮詢", "例行保養與療程", "點滴／針劑", "疫苗", "其他"].map((name, i) => ({
      id: `item-${i + 1}`, name, active: true, sortOrder: i + 1,
    })),
    // 規格 5.1：週五醫師姓名待補，不捏造
    doctors: [
      { id: "doc-liao", displayName: "廖醫師", active: true },
      { id: "doc-yan", displayName: "嚴醫師", active: true },
      { id: "doc-fri", displayName: "週五醫師（姓名待補）", active: true },
    ],
    shifts: [
      { id: "shift-1", doctorId: "doc-liao", weekday: 2, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
      { id: "shift-2", doctorId: "doc-yan", weekday: 4, start: "13:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
      { id: "shift-3", doctorId: "doc-fri", weekday: 5, start: "10:00", end: "17:00", effectiveFrom: "2026-01-01", effectiveTo: null, active: true },
    ],
    blocks: [],
    openings: [{ id: "open-1", weekdays: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00", effectiveFrom: "2026-01-01", effectiveTo: null }],
    appointments: [],
    notifications: [],
    audit: [],
    settings: {
      maxDays: 60,
      notifyEmails: [],
      notifyModes: { sales_cancel: "instant", sales_edit_within_4h: "instant", deputy_action: "instant", duplicate_phone: "instant", sales_edit: "digest" },
    },
    sessions: [],
    idempotency: new Map(),
    loginFailures: new Map(),
    seq: 0,
  };

  // 開發用帳號：只在非正式環境建立，名稱明確標示「開發」，不可當正式人員。
  if (process.env.NODE_ENV !== "production") {
    const devPassword = process.env.DEV_PASSWORD ?? "dev-only-1234";
    db.users.push(
      { id: "u-admin", loginName: "dev-admin", passwordHash: hashPassword(devPassword), displayName: "開發用店長", role: "admin", active: true, createdAt: now },
      { id: "u-deputy", loginName: "dev-deputy", passwordHash: hashPassword(devPassword), displayName: "開發用代理店長", role: "deputy", active: false, createdAt: now },
      { id: "u-s1", loginName: "dev-sales-a", passwordHash: hashPassword(devPassword), displayName: "開發用業務 A", role: "sales", active: true, createdAt: now },
      { id: "u-s2", loginName: "dev-sales-b", passwordHash: hashPassword(devPassword), displayName: "開發用業務 B", role: "sales", active: true, createdAt: now },
    );
    db.salespeople.push(
      { id: "sp-1", displayName: "開發用業務 A", active: true, sortOrder: 1, userAccountId: "u-s1" },
      { id: "sp-2", displayName: "開發用業務 B", active: true, sortOrder: 2, userAccountId: "u-s2" },
    );
  }
  return db;
}

const g = globalThis as unknown as { __clinicDb?: Db };
export const db: Db = (g.__clinicDb ??= seed());

export function nextId(prefix: string): string {
  db.seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${db.seq}`;
}
