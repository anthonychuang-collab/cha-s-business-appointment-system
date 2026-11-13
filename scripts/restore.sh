#!/usr/bin/env bash
# 把 backup.sh 產生的加密備份還原到一個「空的」資料庫。
#
#   RESTORE_DATABASE_URL=... scripts/restore.sh backups/purein-YYYYmmdd-HHMMSS.sql.gz.gpg
#
# - 只還原到全新、空的資料庫（新的 Supabase 專案，或本機測試資料庫）；目標已有資料表即拒絕，
#   不會覆蓋正在使用的正式資料庫。整份在一個交易內執行，失敗就完全不留下任何東西。
# - 還原後重新開啟所有資料表的 RLS 並收回 Supabase 公開角色的權限，再列出各表筆數供核對。
# - 需要 psql、gzip、gpg。自動化時可設 BACKUP_PASSPHRASE_FILE。
set -euo pipefail

file="${1:?用法：RESTORE_DATABASE_URL=... scripts/restore.sh 備份檔}"
: "${RESTORE_DATABASE_URL:?請設定 RESTORE_DATABASE_URL（還原目標，必須是空的資料庫）}"
[[ -f "$file" ]] || { echo "找不到檔案：$file" >&2; exit 1; }
for cmd in psql gzip gpg; do
  command -v "$cmd" >/dev/null || { echo "找不到 $cmd，請先安裝（macOS：brew install postgresql@17 gnupg）。" >&2; exit 1; }
done

existing=$(psql "$RESTORE_DATABASE_URL" -XAtc "select count(*) from pg_tables where schemaname = 'public'")
if [[ "$existing" != "0" ]]; then
  echo "目標資料庫的 public schema 已有 $existing 張資料表：為避免覆蓋現有資料，只接受空的資料庫。" >&2
  echo "請建立新的 Supabase 專案（或新的本機資料庫）再還原。" >&2
  exit 1
fi

gpg_args=(--decrypt --quiet)
if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  gpg_args=(--batch --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" "${gpg_args[@]}")
fi

echo "還原中…"
# pg_dump --schema=public 會輸出 CREATE SCHEMA "public"；目標資料庫本來就有（且已確認是空的），略過這一行
gpg "${gpg_args[@]}" "$file" | gunzip | sed '/^CREATE SCHEMA "public";$/d' \
  | psql "$RESTORE_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null

# 與 supabase/migrations 的最後一段相同：關閉 Supabase 公開 API 的存取
psql "$RESTORE_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
  end loop;
end $$;
SQL

echo "完成。各資料表筆數（請與備份當時核對）："
psql "$RESTORE_DATABASE_URL" -X -A -F $'\t' -c "
  select 'appointments' as 資料表, count(*) as 筆數 from appointments
  union all select 'user_accounts', count(*) from user_accounts
  union all select 'salespeople', count(*) from salespeople
  union all select 'notifications', count(*) from notifications
  union all select 'audit_logs', count(*) from audit_logs
  union all select 'app_migrations', count(*) from app_migrations" | sed '$d'
