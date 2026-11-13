#!/usr/bin/env bash
# 加密備份資料庫（public schema：所有預約、帳號、設定、紀錄）。
#
#   BACKUP_DATABASE_URL=... scripts/backup.sh [輸出資料夾，預設 backups]
#
# - BACKUP_DATABASE_URL 用 Supabase 的「Session pooler」（port 5432）或直接連線，不要用 Transaction pooler（6543）。
# - 需要 pg_dump（版本 ≥ 資料庫版本）、gzip、gpg。
# - 執行時會要求輸入加密密碼兩次。檔案含客戶個資與照護備註，密碼請與備份檔分開保管。
#   自動化時可設 BACKUP_PASSPHRASE_FILE（密碼檔，權限 600）。
set -euo pipefail
umask 077

: "${BACKUP_DATABASE_URL:?請設定 BACKUP_DATABASE_URL（Supabase Session pooler 連線字串）}"
for cmd in pg_dump gzip gpg; do
  command -v "$cmd" >/dev/null || { echo "找不到 $cmd，請先安裝（macOS：brew install postgresql@17 gnupg）。" >&2; exit 1; }
done

out_dir="${1:-backups}"
mkdir -p "$out_dir"
file="$out_dir/purein-$(date +%Y%m%d-%H%M%S).sql.gz.gpg"

gpg_args=(--symmetric --cipher-algo AES256 --output "$file")
if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  gpg_args=(--batch --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" "${gpg_args[@]}")
fi

echo "備份中…"
# --no-owner/--no-privileges：還原到新的 Supabase 專案時不受原本角色影響（restore.sh 會重新鎖上權限）
if ! pg_dump "$BACKUP_DATABASE_URL" --schema=public --no-owner --no-privileges --quote-all-identifiers \
    | gzip -9 | gpg "${gpg_args[@]}"; then
  rm -f "$file"
  echo "備份失敗，已刪除不完整的檔案。" >&2
  exit 1
fi

size=$(wc -c < "$file" | tr -d ' ')
sum=$( (command -v sha256sum >/dev/null && sha256sum "$file" || shasum -a 256 "$file") | cut -d' ' -f1)
echo "完成：$file（$size bytes）"
echo "SHA-256：$sum"
echo "請把檔案存到診所指定的離線位置，並記下 SHA-256 以便日後確認檔案未損壞。"
