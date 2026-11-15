-- -------------------------------------------------------------
-- Japan Inbound Rules MCP & AI Micro Store
-- Supabase State Storage Schema (PostgreSQL REST API)
-- -------------------------------------------------------------

create table if not exists ai_micro_store_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security (RLS) 有効化
-- Service Role Key (secret) からのみフルアクセス可能
alter table ai_micro_store_state enable row level security;
