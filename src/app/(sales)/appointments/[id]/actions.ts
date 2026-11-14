"use server";
import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { updateSalesAppointment } from "@/lib/booking";
import { sameItems } from "@/lib/domain/rules";

export type FormState = { ok: boolean; message: string } | null;

async function run(id: string, version: number, changes: Parameters<typeof updateSalesAppointment>[4], okMsg: string): Promise<FormState> {
  const me = await requireUser(["sales"]);
  const r = await updateSalesAppointment(me.user, me.salesperson!.id, String(id), Number(version), changes);
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
  const orig = JSON.parse(String(f.get("orig") ?? "{}")) as { itemIds?: string[]; requiresDoctor: boolean };
  const itemIds = f.getAll("itemIds").map(String);
  const requiresDoctor = f.get("requiresDoctor") === "yes";
  const changes: { itemIds?: string[]; requiresDoctor?: boolean } = {};
  if (!sameItems(itemIds, orig.itemIds ?? [])) changes.itemIds = itemIds;
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
