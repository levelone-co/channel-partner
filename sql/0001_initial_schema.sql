-- Phase 0 initial schema for the AI communication platform.
-- Multi-tenant from day 1. Service role bypasses RLS; client-scoped policies come in Phase 1.

create extension if not exists vector;

-- ---------- tenants ----------
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  shopify_domain text,
  ghl_location_id text,
  created_at timestamptz not null default now()
);

insert into tenants (slug, name)
values ('level_24_wines', 'Level 24 Wines')
on conflict (slug) do nothing;

-- ---------- conversations ----------
-- Source of truth for every message. Logged whether or not the Claude call succeeds.
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id text not null,
  channel text not null check (channel in ('web','whatsapp','sms','email','voice')),
  role text not null check (role in ('user','assistant','tool','system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversations_lookup
  on conversations (tenant_id, contact_id, created_at desc);

-- ---------- wines ----------
-- Embedding dim 512 matches Voyage voyage-3-lite. If the model changes, drop+recreate this column.
create table if not exists wines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  shopify_product_id text not null,
  handle text,
  title text not null,
  varietal text,
  vintage text,
  price numeric,
  description text,
  pairings text,
  awards text,
  inventory_available boolean not null default true,
  embedding vector(512),
  updated_at timestamptz not null default now(),
  unique (tenant_id, shopify_product_id)
);

-- With a handful of wines no ANN index is needed. When the catalogue grows past ~1k rows:
-- create index wines_embedding_hnsw on wines using hnsw (embedding vector_cosine_ops);

-- ---------- prompts ----------
-- Synced from prompts/*.md in the Git repo via the sync-prompts GitHub Action.
create table if not exists prompts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  content text not null,
  version text not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

-- ---------- RLS scaffolding ----------
-- Service role (used by n8n + ingestion scripts) bypasses RLS automatically.
-- These policies stay empty for Phase 0; Phase 1 will add per-tenant client-scoped access.
alter table tenants enable row level security;
alter table conversations enable row level security;
alter table wines enable row level security;
alter table prompts enable row level security;
