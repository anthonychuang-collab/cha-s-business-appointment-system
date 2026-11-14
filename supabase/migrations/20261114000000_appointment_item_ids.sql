-- 預約項目改為可複選（2026-11-14 決策）
-- 新欄位 item_ids 依選擇順序存放所有項目；item_id 保留為第一個項目，讓舊版程式在
-- 「先 migrate、後部署」之間仍能正常讀寫。觸發器負責兩欄一致：
--   - 舊版程式只寫 item_id → item_ids 自動設成 {item_id}
--   - 新版程式寫 item_ids → item_id 自動設成第一個
-- 陣列無法設外鍵：項目存在與否由程式檢查；有預約用過的項目只能停用不能刪除（admin.ts）。

alter table appointments add column item_ids uuid[] not null default '{}';
update appointments set item_ids = array[item_id];

create function appointments_sync_item_ids() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.item_ids is not distinct from old.item_ids and new.item_id is distinct from old.item_id then
    -- 舊版程式只改了 item_id
    new.item_ids := array[new.item_id];
  elsif cardinality(new.item_ids) = 0 then
    new.item_ids := array[new.item_id];
  else
    new.item_id := new.item_ids[1];
  end if;
  return new;
end $$;

create trigger appointments_sync_item_ids
  before insert or update on appointments
  for each row execute function appointments_sync_item_ids();

alter table appointments add constraint appointments_item_ids_count check (cardinality(item_ids) between 1 and 5);
create index appointments_item_ids_idx on appointments using gin (item_ids);
