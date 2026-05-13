-- Vector search over wines, called from n8n as a Supabase RPC.
-- Returns the top N nearest wines by cosine distance, scoped to a single tenant.

create or replace function search_wines(
  p_tenant_id uuid,
  p_query_embedding vector(512),
  p_match_count int default 3
)
returns table (
  id uuid,
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
