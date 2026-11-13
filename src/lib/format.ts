/** 前後端共用的顯示工具（不含任何資料存取） */
export const WEEKDAY_LABEL = ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"];

export function endOf(start: string): string {
  const h = Number(start.slice(0, 2)) + 1;
  return `${String(h).padStart(2, "0")}:00`;
}

export function displayDate(date: string): string {
  const d = new Date(date + "T00:00:00Z").getUTCDay();
  return `${date.replaceAll("-", " / ")}（${"日一二三四五六"[d]}）`;
}

export const STATUS_LABEL = { active: "已預約", completed: "已到診", no_show: "未到", cancelled: "已取消" } as const;
export const STATUS_BADGE = { active: "", completed: "gray", no_show: "sand", cancelled: "gray" } as const;
export const CONFLICT_LABEL = { OUTSIDE_HOURS: "已非營業時間", BLOCKED: "全院封鎖", DOCTOR_UNAVAILABLE: "醫師請假或不在班" } as const;

export const RULE_MESSAGE: Record<string, string> = {
  LEAD_TIME: "需在時段開始前至少 1 小時預約。",
  TOO_FAR: "超過可預約的最遠日期。",
  NOT_ON_HOUR: "預約需整點開始。",
  WITHIN_4H: "距開始不足 4 小時，無法變更時間、項目、醫師需求或取消。如需更改請聯絡店長。",
  STARTED: "此預約已開始，無法修改。",
  NOT_ACTIVE: "此預約已非有效狀態，無法修改。",
  FORBIDDEN_FIELD: "業務無法變更負責業務，請聯絡店長。",
  NO_CHANGES: "沒有任何變更。",
  OUTSIDE_HOURS: "此時段不在營業時間內。",
  BLOCKED: "此時段已被全院封鎖。",
  NO_DOCTOR: "此時段沒有醫師在班。",
  REASON_REQUIRED: "此時段已有預約，加開需填寫原因。",
  FULL: "此時段已被預約，如需同時段預約請訊息店長。",
  VERSION: "此預約已被更新，請重新載入後再修改。",
};
