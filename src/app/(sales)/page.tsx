import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { listOwnAppointments, pageRef } from "@/lib/booking";
import { WEEKDAY_LABEL } from "@/lib/format";
import { Footer, SalesHeader } from "@/components/Chrome";

export default async function Home() {
  const me = await requireUser(["sales"]);
  const mine = (await listOwnAppointments(me.salesperson!.id)).filter((a) => a.status === "active");
  const conflicts = mine.filter((a) => a.conflictStatus === "conflict").length;
  const opening = (await pageRef()).openings[0];
  const days = opening ? `${WEEKDAY_LABEL[opening.weekdays[0]]}至${WEEKDAY_LABEL[opening.weekdays.at(-1)!]}` : "";

  return (
    <>
      <SalesHeader me={me} tab="home" />
      <main>
        <section className="hero">
          <div>
            <div className="eyebrow">A thoughtful beginning</div>
            <h1>為每一次到訪，<br />留一段專屬時光。</h1>
            <div className="english">Care begins with a moment.</div>
            <p>{me.user.displayName}，從一個簡單的預約開始，<br />讓專業照護自然融入生活。</p>
            <Link className="btn" href="/book">建立新預約　↗</Link>
            {opening && <p className="muted">{days} {opening.start}–{opening.end} · 每次預約 60 分鐘</p>}
          </div>
          <div className="arch">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/clinic.png" alt="樸原健康診所暖色調接待空間" />
            <small>PURE IN / A SPACE FOR WELLBEING</small>
          </div>
        </section>
        <div className="quickrow">
          <Link href="/appointments">
            <b>{String(mine.length).padStart(2, "0")}</b>
            <span>即將到來的預約<small>UPCOMING APPOINTMENTS</small></span>
          </Link>
          <Link href="/appointments?filter=conflict">
            <b style={conflicts ? { color: "var(--red)" } : undefined}>{String(conflicts).padStart(2, "0")}</b>
            <span>需要處理的預約<small>{conflicts ? "請聯絡客戶改期或確認" : "目前沒有待處理項目"}</small></span>
          </Link>
          <Link href="/book">
            <b>↗</b>
            <span>查看可預約時段<small>FIND YOUR MOMENT</small></span>
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
