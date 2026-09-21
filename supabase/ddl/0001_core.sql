-- 0001_core.sql — p2p-net 核心 DDL（精简、幂等、可重放）
--
-- 应用通道：Supabase Management API /database/query 整包执行。该通道不记 migration
-- 历史，init 可重入，靠幂等保证可重放：create table if not exists /
-- drop policy if exists + create policy / create or replace function。
--
-- 来源（自真实 migration 蒸馏，SQL 细节以源文件为准）：
--   - public.signaling_messages（表 + 索引 + RLS + 末尾 revoke anon）：
--     照抄 devanywhere-website/supabase/migrations/0009_signaling.sql
--   - public.pairing_tickets、public.devices 账号域形态：
--     照抄 DevAnyWhere/supabase/migrations/0002_auth_scan_login.sql 账号域部分；
--     devices 改为整表新建（源文件是 alter 既有 v1 表），v1 死字段
--     network_name/network_secret/virtual_ip/invite_code 不带入；
--     源文件策略未带 drop policy if exists，此处补齐以满足幂等
--   - public.bind_device_auth：
--     以 DevAnyWhere/supabase/migrations/0003_invite_redemption.sql 版本为底，
--     删除邀请闸（invite_required）分支与邀请码回填；随 v1 死字段退场，
--     网络凭据分配 / 10.144.144.x IP 分配 / devices_exhausted 上限 / 硬编码 relays
--     一并删除，返回值由 jsonb 精简为 uuid（设备 id）

-- ============ 账号域：设备 ============

create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'phone',
  hostname     text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists devices_user_idx on public.devices(user_id);

alter table public.devices enable row level security;

drop policy if exists devices_owner_select on public.devices;
create policy devices_owner_select on public.devices
  for select to authenticated using (user_id = auth.uid());

-- ============ 账号域：配对票据 ============

create table if not exists public.pairing_tickets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'redeemed', 'expired')),
  device_label text not null default '',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '120 seconds'),
  redeemed_at  timestamptz
);
create index if not exists pairing_tickets_user_idx on public.pairing_tickets(user_id);

alter table public.pairing_tickets enable row level security;

drop policy if exists tickets_owner_insert on public.pairing_tickets;
create policy tickets_owner_insert on public.pairing_tickets
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists tickets_owner_select on public.pairing_tickets;
create policy tickets_owner_select on public.pairing_tickets
  for select to authenticated using (user_id = auth.uid());

-- ============ 设备绑定 RPC（security definer，无邀请闸） ============

create or replace function public.bind_device_auth(p_role text default 'phone', p_hostname text default '')
returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- 同一用户并发绑定串行化
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  -- 幂等键 (user_id, role, hostname)：重复绑定直接返回既有设备 id（重登录不产生新行）
  select d.id into v_device_id
    from public.devices d
    where d.user_id = v_uid and d.role = left(p_role, 16) and d.hostname = left(p_hostname, 64)
    order by d.created_at asc limit 1;

  if v_device_id is null then
    insert into public.devices (user_id, role, hostname)
    values (v_uid, left(p_role, 16), left(p_hostname, 64))
    returning id into v_device_id;
  else
    update public.devices d set last_seen_at = now() where d.id = v_device_id;
  end if;

  return v_device_id;
end;
$$;

revoke all on function public.bind_device_auth(text, text) from public;
revoke all on function public.bind_device_auth(text, text) from anon;
grant execute on function public.bind_device_auth(text, text) to authenticated;

-- ============ 信令表（房间=账号+deviceId；RLS owner-only） ============

create table if not exists public.signaling_messages (
  id         bigint generated always as identity primary key,
  room       text not null,
  sender     text not null,
  kind       text not null default 'sig' check (kind in ('sig','data')),
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '120 seconds'
);

create index if not exists signaling_messages_room_id_idx
  on public.signaling_messages (room, id);
create index if not exists signaling_messages_expires_idx
  on public.signaling_messages (expires_at);

alter table public.signaling_messages enable row level security;

-- 房间名约定：'sig:<auth.uid>:<deviceId>'；同账号设备互写对方房间即信令通路
drop policy if exists signaling_owner_insert on public.signaling_messages;
create policy signaling_owner_insert on public.signaling_messages
  for insert to authenticated
  with check (room like 'sig:' || auth.uid()::text || ':%');

drop policy if exists signaling_owner_select on public.signaling_messages;
create policy signaling_owner_select on public.signaling_messages
  for select to authenticated
  using (room like 'sig:' || auth.uid()::text || ':%');

-- 只允许清理自己房间里已过期的行（防表膨胀；未过期行由读取方 TTL 过滤）
drop policy if exists signaling_owner_delete on public.signaling_messages;
create policy signaling_owner_delete on public.signaling_messages
  for delete to authenticated
  using (room like 'sig:' || auth.uid()::text || ':%' and expires_at < now());

-- Supabase 默认给 anon 的权限面要显式收紧
revoke all on public.signaling_messages from anon;
