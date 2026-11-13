/**
 * Email 內容（規格 7.4）。純函式：不碰資料庫、不寄信，方便測試。
 * - 內容含事件類型、操作者、預約摘要、修改前後差異、後台連結
 * - 不放密碼與憑證；照護備註只寫「已修改」，不寫全文
 */
import type { Appointment, NotifyEvent } from "@/lib/data/types";
import type { ConflictReason } from "@/lib/domain/conflicts";
import { minutesToTime, toTaipei } from "@/lib/domain/time";

export const EVENT_LABEL: Record<NotifyEvent, string> = {
  sales_cancel: "業務取消預約",
  sales_edit_within_4h: "業務於 4 小時內修改",
  deputy_action: "代理店長操作",
  duplicate_phone: "重複電話預約",
  sales_edit: "業務修改預約",
};

const STATUS: Record<Appointment["status"], string> = { active: "已預約", completed: "已到診", no_show: "未到", cancelled: "已取消" };
const CONFLICT_STATUS: Record<Appointment["conflictStatus"], string> = { none: "正常", conflict: "需處理", kept: "店長保留" };
const CONFLICT_REASON: Record<ConflictReason, string> = { OUTSIDE_HOURS: "已非營業時間", BLOCKED: "全院封鎖", DOCTOR_UNAVAILABLE: "醫師請假或不在班" };

/** 事件當下的預約摘要（名稱已解析，之後改名也不影響當時的信件內容） */
export interface AppointmentSnapshot {
  code: string;
  date: string;
  start: string;
  end: string;
  customerName: string;
  phone: string;
  itemName: string;
  partySize: number;
  requiresDoctor: boolean;
  doctorName: string;
  salespersonName: string;
  status: Appointment["status"];
}

export interface ChangeLine {
  label: string;
  from: string;
  to: string;
}

export interface NotificationPayload {
  appointment?: AppointmentSnapshot;
  changes?: ChangeLine[];
  /** 重複電話：同一支電話的其他未來預約 */
  related?: AppointmentSnapshot[];
}

export interface Names {
  itemName: (id: string) => string;
  doctorName: (id: string | null) => string;
  salespersonName: (id: string) => string;
}

export function snapshotOf(a: Appointment, n: Names): AppointmentSnapshot {
  return {
    code: a.code, date: a.date, start: a.start, end: a.end, customerName: a.customerName, phone: a.phone,
    itemName: n.itemName(a.itemId), partySize: a.partySize, requiresDoctor: a.requiresDoctor,
    doctorName: a.requiresDoctor ? n.doctorName(a.assignedDoctorId) : "—", salespersonName: n.salespersonName(a.salespersonId), status: a.status,
  };
}

/** 信件裡要列出的欄位與顯示方式；未列出的（內部欄位）不寄 */
const FIELDS: Partial<Record<keyof Appointment, { label: string; show: (v: unknown, n: Names) => string }>> = {
  customerName: { label: "姓名", show: (v) => String(v) },
  phone: { label: "電話", show: (v) => String(v) },
  date: { label: "日期", show: (v) => String(v) },
  start: { label: "時段", show: (v) => String(v) },
  itemId: { label: "項目", show: (v, n) => n.itemName(String(v)) },
  partySize: { label: "人數", show: (v) => `${v} 人` },
  requiresDoctor: { label: "醫師需求", show: (v) => (v ? "需醫師" : "僅護理師") },
  assignedDoctorId: { label: "安排醫師", show: (v, n) => n.doctorName((v as string | null) ?? null) },
  preferredDoctorNote: { label: "醫師需求備註", show: (v) => String(v) || "（空白）" },
  salespersonId: { label: "負責業務", show: (v, n) => n.salespersonName(String(v)) },
  status: { label: "狀態", show: (v) => STATUS[v as Appointment["status"]] ?? String(v) },
  isOverbooked: { label: "超額加開", show: (v) => (v ? "是" : "否") },
  overbookReason: { label: "加開原因", show: (v) => String(v) || "（空白）" },
  conflictStatus: { label: "衝突狀態", show: (v) => CONFLICT_STATUS[v as Appointment["conflictStatus"]] ?? String(v) },
  conflictReasons: { label: "衝突原因", show: (v) => ((v as ConflictReason[]).map((r) => CONFLICT_REASON[r]).join("、") || "無") },
  conflictKeptNote: { label: "保留原因", show: (v) => String(v) || "（空白）" },
};

/**
 * 把 booking.ts 的 diff（{ 欄位: { from, to } }）轉成信件用的文字。
 * 照護備註一律只寫「已修改」。
 */
export function describeChanges(diff: Record<string, unknown>, n: Names): ChangeLine[] {
  const out: ChangeLine[] = [];
  for (const [key, value] of Object.entries(diff)) {
    if (key === "careNote") {
      out.push({ label: "照護備註", from: "", to: "已修改（內容請登入後台查看）" });
      continue;
    }
    const f = FIELDS[key as keyof Appointment];
    if (!f || typeof value !== "object" || value === null || !("from" in value) || !("to" in value)) continue;
    const { from, to } = value as { from: unknown; to: unknown };
    out.push({ label: f.label, from: f.show(from, n), to: f.show(to, n) });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 台北時間 "YYYY-MM-DD HH:MM"（不用 toLocaleString：各主機 ICU 版本輸出不一致） */
export function taipeiTime(iso: string): string {
  const t = toTaipei(new Date(iso));
  return `${t.date} ${minutesToTime(t.minutes)}`;
}

function snapshotLines(a: AppointmentSnapshot): [string, string][] {
  return [
    ["預約編號", a.code],
    ["日期時段", `${a.date} ${a.start}–${a.end}`],
    ["客戶", `${a.customerName}（${a.phone}）`],
    ["項目", `${a.itemName}・${a.partySize} 人`],
    ["醫師", a.requiresDoctor ? `需醫師：${a.doctorName}` : "僅護理師"],
    ["負責業務", a.salespersonName],
    ["狀態", STATUS[a.status]],
  ];
}

export interface InstantEmailInput {
  event: NotifyEvent;
  summary: string;
  actorName: string;
  createdAt: string;
  appointmentId: string | null;
  payload: NotificationPayload;
  /** 例：https://booking.example.com；未設定時信中改寫「請登入後台查看」 */
  baseUrl?: string;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export function buildInstantEmail(i: InstantEmailInput): EmailContent {
  const label = EVENT_LABEL[i.event];
  const a = i.payload.appointment;
  const subject = `[PURE IN 預約] ${label}${a ? `｜${a.date} ${a.start} ${a.code}` : ""}`;
  const link = i.baseUrl
    ? `${i.baseUrl.replace(/\/+$/, "")}${i.appointmentId ? `/admin/appointments/${i.appointmentId}` : "/admin/notifications"}`
    : null;

  const head: [string, string][] = [["事件", label], ["操作者", i.actorName], ["時間", taipeiTime(i.createdAt)], ["摘要", i.summary]];
  const changes = i.payload.changes ?? [];
  const related = i.payload.related ?? [];

  // ---- 純文字 ----
  const text: string[] = head.map(([k, v]) => `${k}：${v}`);
  if (a) text.push("", "【預約】", ...snapshotLines(a).map(([k, v]) => `${k}：${v}`));
  if (changes.length) text.push("", "【修改內容】", ...changes.map((c) => (c.from ? `${c.label}：${c.from} → ${c.to}` : `${c.label}：${c.to}`)));
  if (related.length) {
    text.push("", "【同一電話的其他預約】");
    for (const r of related) text.push(`${r.code}　${r.date} ${r.start}　${r.customerName}　${r.itemName}　負責業務 ${r.salespersonName}`);
  }
  text.push("", link ? `後台查看：${link}` : "詳細內容請登入後台查看。", "", "此信由 PURE IN 內部預約系統自動寄出；照護備註等詳細內容請登入後台查看。");

  // ---- HTML ----
  const rows = (pairs: [string, string][]) =>
    pairs.map(([k, v]) => `<tr><th align="left" style="padding:4px 12px 4px 0;color:#6b5e52;font-weight:normal;white-space:nowrap">${esc(k)}</th><td style="padding:4px 0">${esc(v)}</td></tr>`).join("");
  const section = (title: string, body: string) => `<h3 style="margin:20px 0 8px;font-size:15px;color:#3d342c">${esc(title)}</h3>${body}`;
  const html = [
    `<div style="font-family:-apple-system,'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif;color:#2b241e;font-size:14px;line-height:1.6;max-width:560px">`,
    `<h2 style="font-size:18px;margin:0 0 12px">${esc(label)}</h2>`,
    `<table style="border-collapse:collapse">${rows(head)}</table>`,
    a ? section("預約", `<table style="border-collapse:collapse">${rows(snapshotLines(a))}</table>`) : "",
    changes.length
      ? section("修改內容", `<table style="border-collapse:collapse">${changes.map((c) => `<tr><th align="left" style="padding:4px 12px 4px 0;color:#6b5e52;font-weight:normal;white-space:nowrap">${esc(c.label)}</th><td style="padding:4px 0">${c.from ? `${esc(c.from)} → ` : ""}<b>${esc(c.to)}</b></td></tr>`).join("")}</table>`)
      : "",
    related.length
      ? section("同一電話的其他預約", `<ul style="padding-left:18px;margin:0">${related.map((r) => `<li>${esc(`${r.code}　${r.date} ${r.start}　${r.customerName}　${r.itemName}　負責業務 ${r.salespersonName}`)}</li>`).join("")}</ul>`)
      : "",
    `<p style="margin-top:24px">${link ? `<a href="${esc(link)}" style="color:#8a5a3b">到後台查看 ↗</a>` : "詳細內容請登入後台查看。"}</p>`,
    `<p style="color:#8c8177;font-size:12px">此信由 PURE IN 內部預約系統自動寄出；照護備註等詳細內容請登入後台查看。</p>`,
    `</div>`,
  ].join("");

  return { subject, text: text.join("\n"), html };
}
