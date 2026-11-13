import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { doctorName, getOwnAppointment, itemName } from "@/lib/booking";
import { displayDate } from "@/lib/format";
import { Footer, SalesHeader } from "@/components/Chrome";

export default async function Done({ params }: PageProps<"/book/done/[id]">) {
  const { id } = await params;
  const me = await requireUser(["sales"]);
  const a = getOwnAppointment(me.salesperson!.id, id);
  // 只有本人建立的預約才看得到成功頁
  if (!a || a.createdBy !== me.user.id) notFound();

  return (
    <>
      <SalesHeader me={me} />
      <main className="content">
        <div className="success">
          <div className="seal" aria-hidden>✓</div>
          <div className="eyebrow">A moment reserved</div>
          <h1>專屬時光，已為你保留。</h1>
          <p className="muted">預約已成功儲存。</p>
          <div className="ticket">
            <div className="eyebrow">{a.code}</div>
            <div className="bigdate">{displayDate(a.date)}</div>
            <h3 style={{ marginTop: 12 }}>{a.start} — {a.end}</h3>
            <div className="sumline">
              {a.customerName}　·　{itemName(a.itemId)}　·　{a.partySize} 人
              <small>{a.requiresDoctor ? `安排醫師：${doctorName(a.assignedDoctorId)}` : "僅由護理師服務"}　·　負責業務 {me.salesperson!.displayName}</small>
            </div>
          </div>
          <Link className="btn" href="/book">建立下一筆預約</Link>
          <Link className="btn secondary" href="/appointments">前往我的預約</Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
