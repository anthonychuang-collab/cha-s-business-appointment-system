import { requireUser } from "@/lib/auth/session";
import { pageRef, todayTaipei } from "@/lib/booking";
import { listAppointments } from "@/lib/data/repo";
import { sql } from "@/lib/data/db";
import { OCCUPYING_STATUSES } from "@/lib/domain/rules";
import { openingHourRange } from "@/lib/domain/schedule";
import { AdminHeader, Footer } from "@/components/Chrome";
import { AdminCreateForm } from "../AdminCreateForm";

export default async function NewByManager({ searchParams }: PageProps<"/admin/new">) {
  const me = await requireUser(["admin", "deputy"]);
  const sp = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(sp.date)) ? String(sp.date) : todayTaipei();
  const start = /^\d{2}:00$/.test(String(sp.start)) ? String(sp.start) : "10:00";
  const db = await pageRef();
  // 涵蓋所有營業日的時段（各星期時間不同時取最早～最晚）；實際是否在營業時間內由伺服器檢查
  const hours = openingHourRange(db.openings).map((h) => `${String(h).padStart(2, "0")}:00`);
  const occupiedCount = (await listAppointments(sql(), { date, start })).filter((a) => OCCUPYING_STATUSES.includes(a.status)).length;

  return (
    <>
      <AdminHeader me={me} tab="overview" />
      <main className="content" style={{ maxWidth: 820 }}>
        <div className="eyebrow">New appointment</div>
        <h1>{occupiedCount ? "超額加開" : "新增預約"}</h1>
        <p className="muted">店長不受「開始前 1 小時」限制，但仍需符合營業時間、封鎖與醫師班表。</p>
        <AdminCreateForm
          date={date} start={start} hours={hours} occupiedCount={occupiedCount}
          salespeople={db.salespeople.filter((s) => s.active).map((s) => ({ id: s.id, name: s.displayName }))}
          items={db.items.filter((i) => i.active).sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ id: i.id, name: i.name }))}
          doctors={db.doctors.filter((d) => d.active).map((d) => ({ id: d.id, name: d.displayName }))}
        />
      </main>
      <Footer />
    </>
  );
}
