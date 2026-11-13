-- Email 通知（規格 7.4）：寄送狀態、重試排程、信件內容所需的事件快照
--
-- 寄送流程（outbox）：通知與預約在同一交易寫入；交易提交後才寄信，寄信失敗不影響預約。
-- email_next_attempt_at：下一次可以嘗試寄送的時間；null = 不需要寄（日報／不寄、已寄出、已放棄）。
-- 取件時先把 email_next_attempt_at 往後推（租約），多個程序同時處理也不會重複寄。

alter table notifications
  add column payload               jsonb not null default '{}',
  add column email_attempts        integer not null default 0,
  add column email_next_attempt_at timestamptz,
  add column email_message_id      text;

create index notifications_email_due_idx on notifications (email_next_attempt_at)
  where email_mode = 'instant' and email_sent_at is null and email_next_attempt_at is not null;
