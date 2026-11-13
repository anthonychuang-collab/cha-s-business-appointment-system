/**
 * 操作紀錄的顯示文字（純函式，有單元測試）。
 * 紀錄本身由 booking.ts、admin.ts、scripts/db.mjs 寫入；這裡只負責把 action 與 changes 轉成中文。
 */
import type { AuditLog } from "@/lib/data/types";
import { describeChanges, type Names } from "@/lib/notify/email";

export type EntityType = AuditLog["entityType"];

export const ENTITY_LABEL: Record<EntityType, string> = {
  appointment: "預約", schedule: "班表與營業", doctor: "醫師", item: "預約項目", settings: "系統設定", account: "帳號", salesperson: "業務",
};

const ACTIONS: Record<string, string> = {
  "appointment:create": "建立預約",
  "appointment:update": "修改預約",
  "appointment:cancel": "業務取消預約",
  "appointment:overbook": "店長加開",
  "appointment:reschedule": "店長改期",
  "appointment:reassign": "轉換負責業務",
  "appointment:keep-conflict": "標記衝突保留",
  "appointment:conflict-recompute": "班表異動重新檢查",
  "appointment:status:completed": "標記已到診",
  "appointment:status:no_show": "標記未到",
  "appointment:status:cancelled": "店長取消預約",
  "appointment:status:active": "恢復為已預約",
  "schedule:shift-create": "新增醫師班表",
  "schedule:shift-update": "修改醫師班表",
  "schedule:shift-delete": "刪除醫師班表",
  "schedule:block-create": "新增封鎖／請假",
  "schedule:block-delete": "移除封鎖／請假",
  "schedule:opening-update": "修改營業時間",
  "schedule:update": "修改班表",
  "doctor:doctor-create": "新增醫師",
  "doctor:doctor-update": "修改醫師",
  "item:create": "新增項目",
  "item:update": "修改項目",
  "item:delete": "刪除項目",
  "settings:update": "修改系統設定",
  "account:create": "建立帳號",
  "account:activate": "啟用帳號",
  "account:deactivate": "停用帳號",
  "account:reset-password": "重設密碼",
  "account:bootstrap-admin": "初始化建立第一位店長",
  "salesperson:transfer": "業務離職轉出未來預約",
};

export function actionLabel(entityType: EntityType, action: string): string {
  return ACTIONS[`${entityType}:${action}`] ?? action;
}

/** 篩選選單用：所有已知動作 */
export const ACTION_OPTIONS = Object.entries(ACTIONS)
  .filter(([k]) => k !== "schedule:update")
  .map(([key, label]) => ({ key, label }));

const ROLE: Record<string, string> = { admin: "店長", deputy: "代理店長", sales: "業務" };
const MODE: Record<string, string> = { instant: "即時信", digest: "日報", none: "不寄信" };
const EVENT: Record<string, string> = {
  sales_cancel: "業務取消", sales_edit_within_4h: "4 小時內修改", deputy_action: "代理店長操作", duplicate_phone: "重複電話", sales_edit: "一般修改",
};
const WARNING: Record<string, string> = { DOCTOR_DOUBLE_BOOKED: "醫師同時段已有其他預約（已確認）" };
const REASON: Record<string, string> = { OUTSIDE_HOURS: "已非營業時間", BLOCKED: "全院封鎖", DOCTOR_UNAVAILABLE: "醫師請假或不在班" };

/** 非預約類紀錄的欄位名稱與值的顯示方式 */
const KEYS: Record<string, { label: string; show?: (v: unknown) => string }> = {
  detail: { label: "內容" },
  name: { label: "名稱" },
  displayName: { label: "姓名" },
  active: { label: "狀態", show: (v) => (v ? "啟用" : "停用") },
  order: { label: "排序" },
  maxDays: { label: "最遠可約天數", show: (v) => `${v} 天` },
  notifyEmails: { label: "通知收件地址" },
  loginName: { label: "登入帳號" },
  role: { label: "角色", show: (v) => ROLE[String(v)] ?? String(v) },
  salesperson: { label: "業務" },
  count: { label: "筆數", show: (v) => `${v} 筆` },
};

function keyInfo(key: string): { label: string; show: (v: unknown) => string } {
  if (key.startsWith("notifyMode.")) {
    return { label: `通知方式（${EVENT[key.slice(11)] ?? key.slice(11)}）`, show: (v) => MODE[String(v)] ?? String(v) };
  }
  const k = KEYS[key];
  return { label: k?.label ?? key, show: k?.show ?? ((v) => (v === null || v === undefined || v === "" ? "（空白）" : String(v))) };
}

const isFromTo = (v: unknown): v is { from: unknown; to: unknown } => typeof v === "object" && v !== null && "from" in v && "to" in v;

/** 一筆紀錄的內容，一行一項。不含密碼；照護備註只顯示「已修改」 */
export function auditLines(l: Pick<AuditLog, "entityType" | "action" | "changes">, names: Names): string[] {
  const changes = l.changes ?? {};
  if (l.entityType === "appointment") {
    const out = describeChanges(changes, names).map((c) => (c.from ? `${c.label}：${c.from} → ${c.to}` : `${c.label}：${c.to}`));
    const warnings = changes.warnings;
    if (Array.isArray(warnings) && warnings.length) out.push(`警告：${warnings.map((w) => WARNING[String(w)] ?? String(w)).join("、")}`);
    const reasons = changes.reasons;
    if (l.action === "conflict-recompute" && Array.isArray(reasons) && reasons.length) out.push(`原因：${reasons.map((r) => REASON[String(r)] ?? String(r)).join("、")}`);
    return out;
  }
  // 顯示順序固定（資料庫 jsonb 不保留鍵的順序）
  const order = Object.keys(KEYS);
  const rank = (k: string) => (order.indexOf(k) + 1 || order.length + 1);
  return Object.entries(changes).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([key, value]) => {
    const { label, show } = keyInfo(key);
    return isFromTo(value) ? `${label}：${show(value.from)} → ${show(value.to)}` : `${label}：${show(value)}`;
  });
}
