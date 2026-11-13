import { requireUser } from "@/lib/auth/session";
import { retryDueEmailsSoon } from "@/lib/notify/deliver";

/** 後台只給店長與代理店長；業務直接輸入網址也會被導回（伺服器端檢查） */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireUser(["admin", "deputy"]);
  retryDueEmailsSoon(); // 回應送出後處理到期的即時信重試
  return <>{children}</>;
}
