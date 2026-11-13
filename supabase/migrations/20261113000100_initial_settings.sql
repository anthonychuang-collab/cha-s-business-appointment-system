-- 規格 3.2、5.1 的初始設定（正式環境也需要）。之後一律由店長在後台調整。
-- 週五醫師姓名待補，不捏造；上線前由店長在「醫師與班表」改名。

insert into appointment_items (name, sort_order) values
  ('一般健保看診', 1), ('一般自費看診', 2), ('療程諮詢', 3), ('例行保養與療程', 4),
  ('點滴／針劑', 5), ('疫苗', 6), ('其他', 7);

with d as (
  insert into doctors (display_name) values ('廖醫師'), ('嚴醫師'), ('週五醫師（姓名待補）')
  returning id, display_name
)
insert into doctor_shifts (doctor_id, weekday, start_time, end_time, effective_from)
select d.id, s.weekday, s.start_time, s.end_time, date '2026-01-01'
from d join (values
  ('廖醫師', 2, time '13:00', time '19:00'),
  ('嚴醫師', 4, time '13:00', time '19:00'),
  ('週五醫師（姓名待補）', 5, time '10:00', time '17:00')
) as s (display_name, weekday, start_time, end_time) on s.display_name = d.display_name;

insert into opening_rules (weekdays, start_time, end_time, effective_from)
values (array[1,2,3,4,5,6]::smallint[], '10:00', '19:00', '2026-01-01');

insert into system_settings (key, value) values
  ('max_days', '60'),
  ('notify_emails', '[]'),
  ('notify_modes', '{"sales_cancel":"instant","sales_edit_within_4h":"instant","deputy_action":"instant","duplicate_phone":"instant","sales_edit":"digest"}');
