"use server";
import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { updateSalesAppointment } from "@/lib/booking";

export type FormState = { ok: boolean; message: string } | null;

async function run(id: string, version: number, changes: Parameters<typeof updateSalesAppointment>[4], okMsg: string): Promise<FormState> {
  const me = await requireUser(["sales"]);
  const r = updateSalesAppointment(me.user, me.salesperson!.id, String(id), Number(version), changes);
  if (!r.ok) return { ok: false, message: r.message };
  refresh();
  return { ok: true, message: okMsg };
}

export async function saveBasics(_p: FormState, f: FormData): Promise<FormState> {
  const orig = JSON.parse(String(f.get("orig") ?? "{}")) as Record<string, string>;
  const changes: Record<string, string | number> = {};
  for (const k of ["customerName", "phone", "careNote", "preferredDoctorNote"]) {
    const v = String(f.get(k) ?? "");
    if (v !== orig[k]) changes[k] = v;
  }
  const ps = Number(f.get("partySize"));
  if (String(ps) !== orig.partySize) changes.partySize = ps;
  if (Object.keys(changes).length === 0) return { ok: false, message: "沒有任何變更。" };
  return run(String(f.get("id")), Number(f.get("version")), changes, "已儲存。");
}

export async function saveService(_p: FormState, f: FormData): Promise<FormState> {
  const orig = JSON.parse(String(f.get("orig") ?? "{}")) as { itemId: string; requiresDoctor: boolean };
  const itemId = String(f.get("itemId") ?? "");
  const requiresDoctor = f.get("requiresDoctor") === "yes";
  const changes: { itemId?: string; requiresDoctor?: boolean } = {};
  if (itemId !== orig.itemId) changes.itemId = itemId;
  if (requiresDoctor !== orig.requiresDoctor) changes.requiresDoctor = requiresDoctor;
  if (Object.keys(changes).length === 0) return { ok: false, message: "沒有任何變更。" };
  return run(String(f.get("id")), Number(f.get("version")), changes, "服務內容已更新。");
}

export async function reschedule(id: string, version: number, date: string, start: string, doctorId: string | null): Promise<FormState> {
  return run(id, version, { time: { date: String(date), start: String(start) }, doctorId: doctorId ? String(doctorId) : null }, "已改期。");
}

export async function cancelAppointment(_p: FormState, f: FormData): Promise<FormState> {
  return run(String(f.get("id")), Number(f.get("version")), { cancel: true }, "預約已取消。");
}
