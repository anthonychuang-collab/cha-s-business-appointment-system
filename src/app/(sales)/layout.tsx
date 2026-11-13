import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { retryDueEmailsSoon } from "@/lib/notify/deliver";

/** 前台只給業務；店長與代理店長導向後台（伺服器端檢查） */
export default async function SalesLayout({ children }: LayoutProps<"/">) {
  const me = await requireUser();
  if (me.user.role !== "sales") redirect("/admin");
  retryDueEmailsSoon(); // 回應送出後處理到期的即時信重試
  return <>{children}</>;
}
