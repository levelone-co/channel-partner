-- 0005: Knowledge base (for the consult_knowledge_base tool) + per-tenant
-- Slack webhook (for the consult_team tool).
--
-- Vector column dim 512 matches the voyage-4-lite output_dimension already
-- used by the wines table. Service role bypasses RLS; client-scoped policies
-- come in Phase 1.

create table if not exists knowledge_base (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source text not null,                                -- filename or URL of origin
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(512),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_base_tenant
  on knowledge_base (tenant_id);

alter table knowledge_base enable row level security;

create or replace function search_knowledge_base(
  p_tenant_id uuid,
  p_query_embedding vector(512),
  p_match_count int default 3
)
returns table (
  id uuid,
  source text,
  content text,
  metadata jsonb,
  distance double precision
)
language sql
stable
as $$
  select
    k.id,
    k.source,
    k.content,
    k.metadata,
    (k.embedding <=> p_query_embedding)::double precision as distance
  from knowledge_base k
  where k.tenant_id = p_tenant_id
    and k.embedding is not null
  order by k.embedding <=> p_query_embedding
  limit greatest(p_match_count, 1);
$$;

alter table tenants
  add column if not exists slack_webhook_url text;
