"use server";
import { requireUser } from "@/lib/auth/session";
import { createSalesAppointment, type BookingInput, type CreateResult } from "@/lib/booking";

/**
 * 送出預約。負責業務與建立者一律由伺服器依登入身分決定，不接受前端傳值（規格 6）。
 * idemKey：同一次填寫固定不變，網路重送不會建立第二筆。
 */
export async function submitBooking(input: BookingInput, idemKey: string, confirmDuplicate: boolean): Promise<CreateResult> {
  const me = await requireUser(["sales"]);
  const clean: BookingInput = {
    customerName: String(input.customerName ?? ""),
    phone: String(input.phone ?? ""),
    itemId: String(input.itemId ?? ""),
    partySize: Number(input.partySize),
    requiresDoctor: input.requiresDoctor === true,
    doctorId: input.doctorId ? String(input.doctorId) : null,
    date: String(input.date ?? ""),
    start: String(input.start ?? ""),
    preferredDoctorNote: String(input.preferredDoctorNote ?? "").slice(0, 200),
    careNote: String(input.careNote ?? "").slice(0, 1000),
  };
  return createSalesAppointment(me.user, me.salesperson!.id, clean, `${me.user.id}:${String(idemKey).slice(0, 64)}`, confirmDuplicate === true);
}
