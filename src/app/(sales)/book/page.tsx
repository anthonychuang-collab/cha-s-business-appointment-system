import { requireUser } from "@/lib/auth/session";
import { maxBookableDate, pageRef, todayTaipei } from "@/lib/booking";
import { WEEKDAY_LABEL } from "@/lib/format";
import { Footer, SalesHeader } from "@/components/Chrome";
import { BookingWizard } from "./BookingWizard";

export default async function BookPage() {
  const me = await requireUser(["sales"]);
  const db = await pageRef();
  const items = db.items.filter((i) => i.active).sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ id: i.id, name: i.name }));
  const activeDoctors = new Set(db.doctors.filter((d) => d.active).map((d) => d.id));
  const shiftHints = db.shifts
    .filter((s) => s.active && activeDoctors.has(s.doctorId))
    .map((s) => ({ weekday: s.weekday, text: `${db.doctors.find((d) => d.id === s.doctorId)!.displayName} ${s.start}–${s.end}` }));
  const weekly = [...new Set(shiftHints.map((h) => h.weekday))].sort().map((w) => `${WEEKDAY_LABEL[w]} ${shiftHints.filter((h) => h.weekday === w).map((h) => h.text).join("、")}`);

  return (
    <>
      <SalesHeader me={me} tab="book" />
      <main className="content">
        <BookingWizard
          salespersonName={me.salesperson!.displayName}
          items={items}
          today={todayTaipei()}
          maxDate={await maxBookableDate()}
          shiftHints={shiftHints}
          weeklyDoctors={weekly}
        />
      </main>
      <Footer />
    </>
  );
}
