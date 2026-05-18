# n8n workflow changes for Step 4 — Shopify cart tools

Goal: Sarah can `search_wines`, `check_stock`, and `add_to_cart` mid-conversation and hand the customer a real checkout URL. This also retires the cart-hallucination bug — a tool that actually returns a checkout link beats any prompt rule.

Architecture decision: the whole call-Claude → run-tool → loop cycle is implemented as **one Code node** (`workflows/sarah-agent-loop.js`), replacing the `Call Claude` HTTP node. n8n has no native cycles; a self-contained Code node is far more robust and debuggable than a chain of replicated HTTP+IF nodes, and it returns the final Anthropic response in the exact shape the HTTP node did, so every downstream node keeps working untouched.

---

## 1. Supabase

Run `sql/0006_customer_carts.sql` in the SQL Editor. Verify:

```sql
select count(*) from customer_carts;  -- 0
```

## 2. Shopify Storefront API token

Custom App → **API credentials** tab → **Storefront API access token** section. This is the `shpss_...` token you grabbed earlier and set aside. Confirm the app's **Storefront API scopes** include `unauthenticated_read_product_listings`, `unauthenticated_write_checkouts`, and `unauthenticated_read_checkouts` (Shopify admin → the Custom App → Configure Storefront API scopes). Reinstall the app if you change scopes.

## 3. n8n Variables

Add (Settings → Variables) — most already exist from earlier steps:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | existing |
| `SUPABASE_URL` | existing |
| `SUPABASE_SERVICE_ROLE_KEY` | existing |
| `VOYAGE_API_KEY` | existing |
| `GHL_API_TOKEN` | existing |
| `SHOPIFY_STORE_DOMAIN` | `level-24-co.myshopify.com` (no protocol) |
| `SHOPIFY_STOREFRONT_TOKEN` | the `shpss_...` Storefront token from step 2 |

## 4. Replace the `Call Claude` node with the agent loop

1. Open the workflow. Click the **`Call Claude`** HTTP Request node.
2. Note its incoming connection (from `Build Messages`) and outgoing connection (to `Log Assistant Turn`). The error-output wiring to `Log Error` can stay or be removed — the Code node never throws (it catches everything and returns a fallback response), so that branch becomes a harmless dead path.
3. **Delete** the `Call Claude` HTTP node.
4. Add a new **Code** node. Name it exactly **`Call Claude`** (same name → all downstream `$('Call Claude')` references keep resolving).
   - **Language**: JavaScript
   - **Mode**: **Run Once for All Items** (required — the body uses top-level `await` and `return`)
   - **Code**: paste the entire contents of `workflows/sarah-agent-loop.js`.
5. Wire it: `Build Messages` → `Call Claude` (Code) → `Log Assistant Turn`. Same as before.
6. Save.

The Code node returns `[{ json: <final Anthropic response> }]` with `.content[0].text`, `.model`, `.usage`, `.stop_reason` — identical shape to the old HTTP node, plus a `_agent.tool_log` array for debugging (you can later extend `Log Assistant Turn`'s metadata to persist it).

## 5. Behavioural prompt

The `add_to_cart` tool description already enforces "calling this is the only way an item is in the cart — never claim it otherwise". The existing `10-behavioural-training-sale.md` "Never claim actions you haven't taken" section reinforces it. No prompt change strictly required, but once verified you can soften that section since the tool now makes the rule self-enforcing.

## 6. Verify

From the widget (or curl the production webhook):

1. **search_wines**: "show me a couple of reds under R300" → Sarah's reply names real wines; in the n8n execution, the `Call Claude` Code node's output `_agent.tool_log` shows a `search_wines` entry with results.
2. **check_stock**: "is the Shiraz in stock?" → tool_log shows `check_stock` with `available`/`quantity_available`; reply reflects real stock, not a guess.
3. **add_to_cart**: "add two bottles of the Shiraz" → tool_log shows `add_to_cart` returning a `checkout_url`; Sarah's reply contains that URL; Supabase `customer_carts` has a row for the contact.
4. **Cart persistence**: in the same conversation, "also add a bottle of the Chenin" → same `cart_id` in `customer_carts` (updated, not duplicated); checkout URL contains both lines.
5. **No hallucination**: ask her to add something, then check — the item is genuinely in the Shopify cart at the returned URL. She no longer claims additions she didn't make (no tool call = nothing added; she'll ask/confirm instead).

```sql
select tenant_id, contact_id, cart_id, checkout_url, updated_at
from customer_carts order by updated_at desc;
```

## 7. Export + commit

n8n → workflow → `⋯` → **Download** → overwrite `workflows/ai-conversation-core.json`. Validate + commit:

```bash
python3 -c "import json; w=json.load(open('workflows/ai-conversation-core.json')); print(len(w['nodes']),'nodes')"
```

## Notes / gotchas

- **Run Once for All Items is mandatory.** In per-item mode the top-level `await`/`return` won't behave and the loop breaks.
- **`fetch` availability**: n8n Cloud's JS task runner is Node 18+, `fetch` is global. If your instance somehow lacks it, swap `fetch(...)` for `this.helpers.httpRequest(...)` (signature differs — ask and we'll adapt).
- **Variant IDs**: the `wines` table stores numeric `shopify_variant_id`; the loop converts to `gid://shopify/ProductVariant/<id>` for the Storefront API automatically. If search_wines results don't carry the variant id, check the `search_wines` RPC returns `shopify_variant_id` (it does as of `sql/0003`).
- **Storefront cart vs checkout**: `cart.checkoutUrl` is a live, shareable URL that walks the customer straight into Shopify's checkout with the lines pre-loaded. No draft-order/admin involvement.
- **24h WhatsApp / display-name**: unchanged from Step 3 — irrelevant on the Live_Chat widget which is the demo channel.
