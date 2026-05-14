-- 0003: Make `wines` variant-grained.
-- Vintage is modeled as a Shopify Product Variant (one product can have many
-- vintages sold concurrently with their own SKUs/prices/inventory). We store
-- one row per variant so vector search, price, and stock are tracked per
-- vintage. `shopify_product_id` stays for grouping.
--
-- Safe to apply only because `wines` is still empty in Phase 0. If you've
-- already ingested data and need to re-run this, truncate `wines` first.

alter table wines add column if not exists shopify_variant_id text;

-- The table is empty in Phase 0; enforce NOT NULL going forward.
alter table wines alter column shopify_variant_id set not null;

-- Swap uniqueness from (tenant, product) to (tenant, variant).
alter table wines drop constraint if exists wines_tenant_id_shopify_product_id_key;
alter table wines add constraint wines_tenant_variant_unique
  unique (tenant_id, shopify_variant_id);

-- Update the RPC to surface variant_id so Step 4's add_to_cart tool can
-- target the right Shopify variant directly. PG won't let `create or replace`
-- change a function's return type, so drop the prior version first.
drop function if exists search_wines(uuid, vector, integer);

create function search_wines(
  p_tenant_id uuid,
  p_query_embedding vector(512),
  p_match_count int default 3
)
returns table (
  id uuid,
  shopify_product_id text,
  shopify_variant_id text,
  title text,
  varietal text,
  vintage text,
  price numeric,
  description text,
  pairings text,
  awards text,
  distance double precision
)
language sql
stable
as $$
  select
    w.id,
    w.shopify_product_id,
    w.shopify_variant_id,
    w.title,
    w.varietal,
    w.vintage,
    w.price,
    w.description,
    w.pairings,
    w.awards,
    (w.embedding <=> p_query_embedding)::double precision as distance
  from wines w
  where w.tenant_id = p_tenant_id
    and w.inventory_available = true
    and w.embedding is not null
  order by w.embedding <=> p_query_embedding
  limit greatest(p_match_count, 1);
$$;
