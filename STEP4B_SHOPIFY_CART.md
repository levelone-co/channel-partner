# Step 4b — "Shopify Cart" sub-workflow (real Draft Orders via OAuth2)

Replaces the bare permalink with a **real Shopify Draft Order** (admin-visible, attributed, invoice-emailable) using the n8n **Shopify OAuth2 credential** — the only place n8n allows that credential. The permalink stays as an automatic backstop: if this sub-workflow is unset or fails, the agent loop falls back to the permalink so cart behaviour never regresses.

## Architecture

```
Agent loop (Code node)            Shopify Cart workflow (separate)
  add_to_cart / set_cart                Webhook  /webhook/shopify-cart
    → persist permalink (backstop)        → Get Cart Row (Supabase: draft_order_id)
    → POST internal webhook ───────────►  → Plan (POST create vs PUT update)
    ← invoice_url (or permalink fallback) → Shopify Draft (HTTP, OAuth2 cred)
                                          → Result → Persist Cart (Supabase)
                                          → Respond { ok, invoice_url, draft_order_id }
```

The loop sends the **complete desired line set** every call, so the sub-workflow is linear (no need to read Shopify's existing lines). `customer_carts.cart_id` keeps the permalink line-spec (backstop); `draft_order_id` + `checkout_url` (= invoice_url) are written by the sub-workflow.

## Setup

1. **Supabase**: run `sql/0007_customer_carts_draft_order.sql` (adds `customer_carts.draft_order_id`).
2. **Import** `workflows/shopify-cart.json` into n8n.
3. On the **`Shopify Draft`** node → Credentials → select your **`Shopify_account_-_channel-partner_-_level-24-co`** OAuth2 credential (the JSON ships a placeholder; n8n will prompt). This is the verified credential — no token minting anywhere.
4. **Activate** the workflow. Copy its **Production** Webhook URL (e.g. `https://level24co.app.n8n.cloud/webhook/shopify-cart`).
5. In n8n **Settings → Variables**, add `SHOPIFY_CART_WEBHOOK_URL` = that production URL.
6. Re-paste `workflows/sarah-agent-loop.js` into the main workflow's `Call Claude` Code node → save. (It now calls the sub-workflow and falls back to the permalink automatically.)

## Verify

Fresh `contact_id`, via widget or curl the main webhook:
1. "recommend a red, add 2 bottles" → reply has a `checkout_url`. In the main run's `_agent.tool_log`, `add_to_cart.result.via` should be `draft_order` and `checkout_url` a Shopify `…/invoices/…` URL. Shopify admin → Orders → Drafts shows the draft.
2. "remove everything, add 2 chenin" → `set_cart`, same draft updated to just Chenin (check the draft in admin), `via: draft_order`.
3. "clear my cart" → `via: cleared`, `checkout_url: null`.
4. **Backstop test**: blank `SHOPIFY_CART_WEBHOOK_URL` (or stop the sub-workflow) → `via: permalink_backstop`, `checkout_url` is the `/cart/…` permalink. Customer still gets a working link. Restore the Variable after.

`customer_carts`: `draft_order_id` populated, `checkout_url` = invoice_url, `cart_id` still the permalink spec (backstop).

## Notes / limits

- Still does **not** update the storefront cart icon — that's front-end-only (Phase 1 custom widget), unchanged and unrelated.
- `set_cart` always sends the full desired contents; the sub-workflow PUTs the whole `line_items` set, so removes/replaces/quantity changes all work in one call.
- Draft orders can't be empty; "clear" is handled loop-side (no sub-workflow call, `customer_carts` cleared).
- The OAuth2 token is managed entirely by n8n's credential (auto-refresh). No client_credentials, no `atkn_`, no Storefront token anywhere.
