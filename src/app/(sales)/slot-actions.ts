"use server";
/** 前台日期／時段查詢。只回傳可約狀態與醫師名稱，不回傳任何其他客戶資料（規格 6）。 */
import { requireUser } from "@/lib/auth/session";
import { getNames, getOwnAppointment, monthAvailability, salesSlots } from "@/lib/booking";

export interface SlotView {
  start: string;
  end: string;
  available: boolean;
  label: string;
  doctors: { id: string; name: string }[];
}

const LABEL: Record<string, string> = { FULL: "已額滿", LEAD_TIME: "已截止", BLOCKED: "暫停開放", NO_DOCTOR: "無醫師" };

async function allowedExclude(excludeId?: string): Promise<string | undefined> {
  const me = await requireUser(["sales"]);
  if (!excludeId) return undefined;
  return (await getOwnAppointment(me.salesperson!.id, excludeId)) ? excludeId : undefined;
}

export async function fetchMonth(year: number, month: number, requiresDoctor: boolean, excludeId?: string): Promise<Record<string, boolean>> {
  const ex = await allowedExclude(excludeId);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return {};
  return monthAvailability(year, month, requiresDoctor, ex);
}

export async function fetchSlots(date: string, requiresDoctor: boolean, excludeId?: string): Promise<SlotView[]> {
  const ex = await allowedExclude(excludeId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const { doctorName } = await getNames();
  return (await salesSlots(date, requiresDoctor, ex)).map((s) => ({
    start: s.start,
    end: s.end,
    available: s.available,
    label: s.available ? "可預約" : LABEL[s.reason ?? "FULL"],
    doctors: s.doctorIds.map((id) => ({ id, name: doctorName(id) })),
  }));
}
