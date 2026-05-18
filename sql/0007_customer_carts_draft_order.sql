-- 0007: Track the Shopify Draft Order id alongside the permalink backstop.
-- customer_carts.cart_id keeps holding the permalink line-spec
-- ("vid:qty,vid:qty") so the zero-auth permalink backstop still works.
-- draft_order_id holds the Shopify Draft Order id created by the
-- "Shopify Cart" sub-workflow; checkout_url is then the draft's invoice_url.

alter table customer_carts
  add column if not exists draft_order_id text;
