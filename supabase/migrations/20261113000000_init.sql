-- PURE IN 內部預約系統：資料表（對應 src/lib/data/types.ts 與規格第 8、12 節）
-- 日期、時段以台北本地 date / time 保存；稽核、通知、session 時間戳用 timestamptz。
-- 只由伺服器以資料庫連線字串存取；所有資料表啟用 RLS 且不開任何 policy，
-- 讓 Supabase 公開的 REST API（anon / authenticated）完全讀寫不到。

create extension if not exists pgcrypto;

-- ---------- 帳號 ----------

create table user_accounts (
  id            uuid primary key default gen_random_uuid(),
  login_name    text not null check (login_name ~ '^[a-zA-Z0-9._-]{3,30}$'),
  password_hash text not null,
  display_name  text not null check (length(trim(display_name)) > 0),
  role          text not null check (role in ('sales', 'admin', 'deputy')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index user_accounts_login_name_key on user_accounts (lower(login_name));

create table salespeople (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  active          boolean not null default true,
  sort_order      integer not null default 0,
  user_account_id uuid unique references user_accounts (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- 項目、醫師、班表 ----------

create table appointment_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(trim(name)) > 0),
  active     boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table doctors (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) > 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table doctor_shifts (
  id             uuid primary key default gen_random_uuid(),
  doctor_id      uuid not null references doctors (id),
  weekday        smallint not null check (weekday between 1 and 7), -- ISO：1 = 週一
  start_time     time not null,
  end_time       time not null,
  effective_from date not null,
  effective_to   date,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_time > start_time),
  check (effective_to is null or effective_to >= effective_from)
);

-- 規格的 schedule_rules 依程式型別拆成「營業時間」與「封鎖／請假」兩張表，語意相同。
create table opening_rules (
  id             uuid primary key default gen_random_uuid(),
  weekdays       smallint[] not null check (weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
  start_time     time not null,
  end_time       time not null,
  effective_from date not null,
  effective_to   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_time > start_time),
  check (effective_to is null or effective_to >= effective_from)
);

create table schedule_blocks (
  id             uuid primary key default gen_random_uuid(),
  weekday        smallint check (weekday between 1 and 7),
  specific_date  date,
  start_time     time not null,
  end_time       time not null,
  scope          text not null check (scope in ('clinic', 'doctor')),
  doctor_id      uuid references doctors (id),
  effective_from date not null,
  effective_to   date,
  reason         text not null check (length(trim(reason)) > 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((weekday is null) <> (specific_date is null)),
  check ((scope = 'doctor') = (doctor_id is not null)),
  check (end_time > start_time),
  check (effective_to is null or effective_to >= effective_from)
);

-- ---------- 預約 ----------

create table appointments (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  customer_name         text not null check (length(trim(customer_name)) between 1 and 50),
  phone                 text not null,
  phone_normalized      text not null,
  appointment_date      date not null,
  start_time            time not null check (extract(minute from start_time) = 0 and extract(second from start_time) = 0),
  end_time              time not null,
  item_id               uuid not null references appointment_items (id),
  party_size            integer not null check (party_size > 0),
  requires_doctor       boolean not null,
  assigned_doctor_id    uuid references doctors (id),
  preferred_doctor_note text not null default '',
  care_note             text not null default '',
  salesperson_id        uuid not null references salespeople (id),
  status                text not null check (status in ('active', 'completed', 'no_show', 'cancelled')),
  is_overbooked         boolean not null default false,
  overbook_reason       text not null default '',
  conflict_status       text not null default 'none' check (conflict_status in ('none', 'conflict', 'kept')),
  conflict_reasons      text[] not null default '{}',
  conflict_kept_reasons text[] not null default '{}',
  conflict_kept_note    text not null default '',
  created_by            uuid not null references user_accounts (id),
  updated_by            uuid not null references user_accounts (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  cancelled_at          timestamptz,
  version               integer not null default 1,
  check (end_time = start_time + interval '1 hour'),
  check (requires_doctor or assigned_doctor_id is null),
  check (not is_overbooked or length(trim(overbook_reason)) > 0),
  check (conflict_status <> 'kept' or length(trim(conflict_kept_note)) > 0),
  check (conflict_reasons <@ array['OUTSIDE_HOURS','BLOCKED','DOCTOR_UNAVAILABLE']),
  check (conflict_kept_reasons <@ array['OUTSIDE_HOURS','BLOCKED','DOCTOR_UNAVAILABLE'])
);
create index appointments_slot_idx on appointments (appointment_date, start_time);
create index appointments_salesperson_idx on appointments (salesperson_id, appointment_date);
create index appointments_phone_idx on appointments (phone_normalized, appointment_date);
create index appointments_conflict_idx on appointments (appointment_date) where conflict_status = 'conflict';

-- ---------- 通知、稽核、設定 ----------

create table notifications (
  id             uuid primary key default gen_random_uuid(),
  event_type     text not null check (event_type in ('sales_cancel', 'sales_edit_within_4h', 'deputy_action', 'duplicate_phone', 'sales_edit')),
  appointment_id uuid references appointments (id),
  actor_user_id  uuid not null references user_accounts (id),
  summary        text not null,
  email_mode     text not null check (email_mode in ('instant', 'digest', 'none')),
  read_at        timestamptz,
  email_sent_at  timestamptz,
  email_error    text,
  created_at     timestamptz not null default now()
);
create index notifications_created_idx on notifications (created_at desc);

create table audit_logs (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null check (entity_type in ('appointment', 'schedule', 'settings', 'account', 'item', 'doctor', 'salesperson')),
  entity_id     text not null,
  actor_user_id uuid references user_accounts (id),
  action        text not null,
  changes       jsonb not null default '{}',
  reason        text not null default '',
  created_at    timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, created_at desc);

create table system_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references user_accounts (id),
  updated_at timestamptz not null default now()
);

-- ---------- 登入、冪等 ----------

-- 只存 token 的 SHA-256，資料庫外洩也無法直接拿來登入
create table sessions (
  token_hash text primary key,
  user_id    uuid not null references user_accounts (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table login_failures (
  login_key    text primary key,
  count        integer not null,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

create table idempotency_keys (
  key            text primary key,
  appointment_id uuid not null references appointments (id),
  created_at     timestamptz not null default now()
);

-- ---------- 關閉 Supabase 公開 API 的存取 ----------

do $$
declare t text;
begin
  foreach t in array array[
    'user_accounts', 'salespeople', 'appointment_items', 'doctors', 'doctor_shifts', 'opening_rules', 'schedule_blocks',
    'appointments', 'notifications', 'audit_logs', 'system_settings', 'sessions', 'login_failures', 'idempotency_keys'
  ] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %I from authenticated', t);
    end if;
  end loop;
end $$;
