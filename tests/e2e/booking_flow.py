"""實際操作完整流程並截圖。用法：python3 run.py http://localhost:3100 輸出資料夾"""
import sys, os
from playwright.sync_api import sync_playwright, expect

BASE, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
PW = "dev-only-1234"
TUE = "2026-11-17"
log = []

def shot(page, name):
    page.screenshot(path=f"{OUT}/{name}.png", full_page=True)

def login(page, user):
    page.goto(f"{BASE}/login")
    page.get_by_label("使用者帳號").fill(user)
    page.get_by_label("密碼").fill(PW)
    page.get_by_role("button", name="登入").click()
    page.wait_for_load_state("networkidle")

def check(cond, msg):
    log.append(("✓" if cond else "✗") + " " + msg)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- 桌面：業務 A 完整預約 ----------
    ctx = b.new_context(viewport={"width": 1280, "height": 860}, locale="zh-TW")
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto(f"{BASE}/login"); shot(page, "d01_login")
    login(page, "wrong"); check(page.get_by_role("alert").count() > 0, "錯誤帳密顯示錯誤訊息")
    login(page, "dev-sales-a"); shot(page, "d02_home")
    check("為每一次到訪" in page.content(), "業務登入後到首頁")

    page.goto(f"{BASE}/admin"); page.wait_for_load_state("networkidle")
    check(page.url.rstrip("/") == BASE, f"業務直接輸入 /admin 被導回首頁（{page.url}）")

    page.goto(f"{BASE}/book")
    page.get_by_role("button", name="下一步").click()
    shot(page, "d03_step1_errors")
    check(page.locator(".fielderr").count() == 2, "第一步空白送出：兩個欄位錯誤")
    page.get_by_label("預約姓名").fill("測試客戶甲")
    page.get_by_label("聯絡電話").fill("0912-345-678")
    page.get_by_role("button", name="下一步").click()

    page.get_by_role("checkbox", name="療程諮詢").click()
    page.get_by_role("checkbox", name="點滴／針劑").click()
    page.get_by_role("button", name="增加人數").click()
    page.get_by_role("radio", name="是，需安排醫師").click()
    shot(page, "d04_step2")
    page.get_by_role("button", name="下一步").click()

    page.get_by_role("button", name=TUE.replace("-", " / ") + "（二）").click()
    page.wait_for_timeout(600)
    shot(page, "d05_step3_tuesday_doctor")
    slots = page.locator(".slot")
    disabled_before_13 = all(slots.nth(i).is_disabled() for i in range(3))
    check(disabled_before_13, "需醫師：週二 10–12 點時段停用")
    page.get_by_role("button", name="14:00–15:00").click()
    check("廖醫師" in page.content(), "選時段後顯示安排醫師：廖醫師")
    page.get_by_role("button", name="上一步").click()
    page.get_by_role("button", name="下一步").click()
    check(page.get_by_role("button", name="14:00–15:00").get_attribute("aria-pressed") == "true", "上一步再回來，時段選擇保留")
    page.get_by_role("button", name="下一步").click()

    page.get_by_label("特殊需求／照護備註").fill("怕痛，請輕一點")
    shot(page, "d06_step4_confirm")
    page.get_by_role("button", name="確認送出").click()
    check(page.locator("#err-agree").count() == 1, "未勾選確認不能送出")
    page.get_by_label("我已確認以上預約資料正確").check()
    page.get_by_role("button", name="確認送出").click()
    page.wait_for_url("**/book/done/**")
    shot(page, "d07_success")
    check("已為你保留" in page.content(), "送出成功頁")

    page.goto(f"{BASE}/appointments"); shot(page, "d08_my_list")
    check("測試客戶甲" in page.content(), "我的預約看得到剛建立的預約")
    page.get_by_role("link", name="查看").first.click(); page.wait_for_load_state("networkidle")
    page.get_by_text("改期", exact=True).click()
    shot(page, "d09_detail")
    detail_url = page.url
    ctx.close()

    # ---------- 業務 B：同時段額滿、看不到 A 的預約、重複電話 ----------
    ctx = b.new_context(viewport={"width": 1280, "height": 860}, locale="zh-TW")
    page = ctx.new_page()
    login(page, "dev-sales-b")
    page.goto(detail_url); page.wait_for_load_state("networkidle")
    check(page.locator("text=測試客戶甲").count() == 0, "業務 B 用網址看 A 的預約：拿不到資料（404）")
    page.goto(f"{BASE}/book")
    page.get_by_label("預約姓名").fill("測試客戶乙")
    page.get_by_label("聯絡電話").fill("+886 912 345 678")
    page.get_by_role("button", name="下一步").click()
    page.get_by_role("checkbox", name="疫苗").click()
    page.get_by_role("radio", name="否，僅由護理師服務").click()
    page.get_by_role("button", name="下一步").click()
    page.get_by_role("button", name=TUE.replace("-", " / ") + "（二）").click()
    page.wait_for_timeout(600)
    full = page.get_by_role("button", name="14:00–15:00")
    check(full.is_disabled() and "已額滿" in full.inner_text(), "業務 B：14:00 顯示已額滿且不能選")
    shot(page, "d10_salesB_full")
    page.get_by_role("button", name="15:00–16:00").click()
    page.get_by_role("button", name="下一步").click()
    page.get_by_label("我已確認以上預約資料正確").check()
    page.get_by_role("button", name="確認送出").click()
    page.wait_for_timeout(800)
    check("此電話已有預約" in page.content(), "同一支電話（+886 寫法）跳出重複警告")
    shot(page, "d11_duplicate_phone")
    page.get_by_role("button", name="確定建立").click()
    page.wait_for_url("**/book/done/**")
    check(True, "確認後仍可建立")
    ctx.close()

    # ---------- 店長：總覽、請假造成衝突 ----------
    ctx = b.new_context(viewport={"width": 1280, "height": 860}, locale="zh-TW")
    page = ctx.new_page()
    login(page, "dev-admin")
    page.goto(f"{BASE}/admin?date={TUE}"); shot(page, "d12_admin_overview")
    check("測試客戶甲" in page.content() and "測試客戶乙" in page.content(), "店長總覽看得到兩位業務的預約")
    page.goto(f"{BASE}/admin/schedule")
    form = page.locator("form").filter(has_text="原因")
    form.get_by_label("範圍").select_option("doctor")
    form.get_by_label("醫師（請假時）").select_option(label="廖醫師")
    form.get_by_label("日期（指定日期時）").fill(TUE)
    form.get_by_label("原因").fill("廖醫師臨時請假")
    form.get_by_role("button", name="預覽影響").click()
    page.wait_for_timeout(800)
    check("將有 1 筆" in page.content(), "請假前預覽：1 筆預約受影響")
    shot(page, "d13_schedule_preview")
    form.get_by_role("button", name="確認儲存").click()
    page.wait_for_timeout(2500)
    shot(page, "d13b_after_commit")
    log.append("after commit: " + " | ".join(page.locator("p.alert").all_inner_texts()))
    page.goto(f"{BASE}/admin?date={TUE}"); shot(page, "d14_admin_conflict")
    check("1 筆未來預約需要處理" in page.inner_text("body"), "店長總覽顯示 1 筆待處理衝突")
    for path, name in [("/admin/options", "d15_options"), ("/admin/users", "d16_users"), ("/admin/notifications", "d17_notifications")]:
        page.goto(BASE + path); shot(page, name)
    check("重複電話" in page.content(), "通知列出重複電話事件")
    ctx.close()

    # ---------- 手機：業務 A 看到紅字，改成僅護理師解除衝突 ----------
    ctx = b.new_context(viewport={"width": 390, "height": 844}, locale="zh-TW", is_mobile=True, has_touch=True, device_scale_factor=2)
    page = ctx.new_page()
    login(page, "dev-sales-a"); shot(page, "m01_home")
    page.goto(f"{BASE}/appointments"); shot(page, "m02_list_conflict")
    check("有 1 筆預約需要處理" in page.inner_text("body"), "業務 A 手機：我的預約顯示紅字 1 筆需處理")
    page.locator(".card").first.click(); page.wait_for_load_state("networkidle")
    shot(page, "m03_detail_conflict")
    page.get_by_text("修改預約服務").click()
    page.get_by_label("否，僅由護理師服務").check()
    page.get_by_role("button", name="更新服務").click()
    page.wait_for_timeout(1000)
    page.reload()
    check(page.locator(".conflictbar").count() == 0, "改成僅護理師後衝突自動解除")
    page.goto(f"{BASE}/book")
    page.get_by_role("button", name="下一步").click(); shot(page, "m04_step1_error")
    page.get_by_label("預約姓名").fill("手機客戶")
    page.get_by_label("聯絡電話").fill("02-2345-6789#12")
    page.get_by_role("button", name="下一步").click()
    page.get_by_role("checkbox", name="點滴／針劑").click()
    page.get_by_role("radio", name="否，僅由護理師服務").click()
    shot(page, "m05_step2")
    page.get_by_role("button", name="下一步").click()
    page.get_by_role("button", name="2026 / 11 / 18（三）").click()
    page.wait_for_timeout(600)
    shot(page, "m06_step3")
    page.get_by_role("button", name="10:00–11:00").click()
    page.get_by_role("button", name="下一步").click()
    shot(page, "m07_step4")
    page.goto(f"{BASE}/login"); ctx.close()

    b.close()

print("\n".join(log))
print("console errors:", [e for e in errors if "fonts.g" not in e][:5])
