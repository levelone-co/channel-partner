-- 0006: Per-contact Shopify cart persistence for the add_to_cart tool.
-- One live cart per (tenant_id, contact_id). The Storefront API cartCreate
-- mutation returns a cart id + checkoutUrl; we store them so subsequent
-- add_to_cart calls in the same conversation extend the same cart instead
-- of spawning a new one each time.

create table if not exists customer_carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id text not null,
  cart_id text not null,                 -- Shopify Storefront cart GID
  checkout_url text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, contact_id)
);

create index if not exists customer_carts_lookup
  on customer_carts (tenant_id, contact_id);

alter table customer_carts enable row level security;
