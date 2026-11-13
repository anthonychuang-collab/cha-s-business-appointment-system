-- 每日 21:00 日報（規格 7.4）
-- 每天最多一封（digest_date 唯一）；彙整「尚未進過任何日報」的日報事件，沒有事件就不建立、不寄。
-- 寄送狀態與重試欄位和 notifications 的即時信相同（租約＋退避）。

create table email_digests (
  id                    uuid primary key default gen_random_uuid(),
  digest_date           date not null unique, -- 台北日期
  event_count           integer not null check (event_count > 0),
  created_at            timestamptz not null default now(),
  email_sent_at         timestamptz,
  email_error           text,
  email_attempts        integer not null default 0,
  email_next_attempt_at timestamptz,
  email_message_id      text
);

alter table notifications add column digest_id uuid references email_digests (id);

create index notifications_digest_pending_idx on notifications (created_at)
  where email_mode = 'digest' and digest_id is null;
create index email_digests_due_idx on email_digests (email_next_attempt_at)
  where email_sent_at is null and email_next_attempt_at is not null;

alter table email_digests enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table email_digests from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table email_digests from authenticated; end if;
end $$;
