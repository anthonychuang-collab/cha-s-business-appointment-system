import { requireUser } from "@/lib/auth/session";

/** 後台只給店長與代理店長；業務直接輸入網址也會被導回（伺服器端檢查） */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireUser(["admin", "deputy"]);
  return <>{children}</>;
}
