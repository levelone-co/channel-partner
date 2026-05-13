# Phase 0 Setup Runbook

Companion to `PROJECT.md`. This is the **execution checklist** for Step 1.5 + Step 2 of the plan: provision external services, run migrations, ingest the wine catalogue, and import the refactored n8n workflow.

If you are reading this for the first time after a fresh `git clone`, work top to bottom.

---

## 1. External services to set up

Do these in any order; the script and workflow will need them.

### 1.1 Supabase

1. Create a new project at https://supabase.com/dashboard.
2. Once provisioned, go to **Project Settings → API** and copy:
   - **Project URL** → goes into `SUPABASE_URL`
   - **service_role** key → goes into `SUPABASE_SERVICE_ROLE_KEY` *(treat this like a password)*
3. Open **SQL Editor** and run, in order:
   - `sql/0001_initial_schema.sql`
   - `sql/0002_search_wines_rpc.sql`
4. Verify with the SQL editor:
   ```sql
   select extname from pg_extension where extname='vector';      -- 1 row
   select slug from tenants;                                      -- 'level_24_wines'
   ```

### 1.2 Voyage AI

1. Sign up at https://dash.voyageai.com.
2. Create an API key → goes into `VOYAGE_API_KEY`.
3. The plan pins `voyage-3-lite` (512-dim, fixed). If you want a different model later, you must also change `vector(512)` in `0001_initial_schema.sql` and re-embed.

### 1.3 Shopify Admin API

1. In your Shopify admin: **Settings → Apps and sales channels → Develop apps → Create an app**.
2. **Configure Admin API scopes**: `read_products` (required now). For Step 4 also grant `write_draft_orders` and `read_inventory`.
3. **Install app** → copy **Admin API access token** → `SHOPIFY_ADMIN_TOKEN`.
4. The store domain (e.g. `level-24-wines.myshopify.com`) → `SHOPIFY_STORE_DOMAIN`.
5. **Metafield convention** the ingestion script expects:
   - `custom.varietal`, `custom.vintage`, `custom.pairings`, `custom.awards`
   - Falls back to `wine.*` namespace if `custom.*` is empty.
   - Define these once via **Settings → Custom data → Products → Add definition**, then fill them per product.

### 1.4 n8n

1. Open your n8n Cloud / self-hosted instance.
2. **Settings → Variables** (n8n Cloud) or env vars (self-hosted) — define:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VOYAGE_API_KEY`
   - `ANTHROPIC_API_KEY` (the freshly-rotated key)
3. **Workflows → Import from File** → select `workflows/ai-conversation-core.json`.
4. Activate the workflow. The webhook URL will be shown at the top of the Webhook node.

### 1.5 GitHub (for prompt sync)

In the repo settings → **Secrets and variables → Actions → New repository secret**:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

After the first push to `main` that touches `prompts/`, the `Sync prompts to Supabase` workflow runs automatically. You can also trigger it via the **Actions** tab → workflow_dispatch.

### Prompt taxonomy (Phase 0)

Filenames encode `<numeric-order>-<layer>-<scope-or-mode>`. The trailing segment is a **conversation mode** for cross-tenant files (currently `sale`; future `support`, `search`), a **vertical** for cross-tenant domain files (`wine`; future `beauty` etc.), or a **tenant slug** for account-specific files.

| File | Layer | Owner | DB row(s) |
|---|---|---|---|
| `10-behavioural-training-sale.md` | Sales methodology, channel matching, tone | Level 24 platform IP | Synced to every tenant under name `10-behavioural-training-sale` |
| `20-domain-knowledge-wine.md` | Wine vocab, pairings, SA context, regulatory | Level 24 curated | Synced to every tenant under name `20-domain-knowledge-wine` (Phase 1: only wine-vertical tenants) |
| `30-profile-account-level_24_wines.md` | Persona + estate open facts | Account-maintained | Synced **only** to `level_24_wines` under name `30-profile-account` (trailing slug stripped) |
| `40-playbook-account-level_24_wines.md` | Proprietary positioning, sales directives | Account-maintained, confidential | Synced **only** to `level_24_wines` under name `40-playbook-account` |

The sync rule is implemented in `scripts/sync_prompts.py:route()`: if a filename stem ends with `-<known_tenant_slug>`, the trailing segment is stripped and the row is scoped to that tenant; otherwise the row is broadcast to every tenant.

The n8n workflow's `Get Prompt` node fetches names `10-behavioural-training-sale`, `20-domain-knowledge-wine`, `30-profile-account`, `40-playbook-account` (PostgREST joins by `tenant_id` automatically). `Build Messages` concatenates them in numerical order with `\n\n---\n\n`, then appends the retrieved-wine block. When you add a new file, update both the `name=in.(...)` filter and the `promptOrder` array.

### Multi-tenant onboarding (Phase 1, when tenant #2 lands)

```
prompts/
  10-behavioural-training-sale.md                       # cross-tenant
  10-behavioural-training-support.md                    # future mode
  10-behavioural-training-search.md                     # future mode
  20-domain-knowledge-wine.md                           # wine vertical
  20-domain-knowledge-beauty.md                         # future vertical
  30-profile-account-level_24_wines.md                  # tenant #1
  40-playbook-account-level_24_wines.md
  30-profile-account-cape_pinot_co.md                   # tenant #2
  40-playbook-account-cape_pinot_co.md
```

The sync script's tenant-slug suffix logic already handles tenant #2 the moment a row is inserted into `tenants` — no code change needed; just add the new tenant's `.md` files.

To finish multi-tenant correctly we'll still need: a `vertical` column on `tenants` (so only wine-vertical tenants get `20-domain-knowledge-wine`), a `mode` field on the webhook payload (so the right `10-behavioural-training-<mode>` is fetched at runtime), and per-tenant overrides for 10/20 if a client needs custom sales methodology or domain knowledge.

Naming of the IP-holding entity is TBC ("Level 24", "Project 24", or another) — until that's decided, the prompt headers use "Level 24" as a placeholder.

---

## 2. Local setup

```bash
cp .env.example .env       # then fill in real values
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

---

## 3. Run order

```bash
# 1. Schema (run inside Supabase SQL editor, not from CLI)
#    sql/0001_initial_schema.sql
#    sql/0002_search_wines_rpc.sql

# 2. Push prompts to Supabase (or trigger the GitHub Action)
python scripts/sync_prompts.py

# 3. Ingest wines from Shopify
python scripts/ingest_wines.py --tenant level_24_wines

# 4. Import + activate workflows/ai-conversation-core.json in n8n
```

---

## 4. End-to-end test

After all four steps above, hit the n8n webhook:

```bash
curl -sS -X POST https://YOUR-N8N-DOMAIN/webhook/ai-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_slug": "level_24_wines",
    "contact_id": "test-1",
    "channel": "web",
    "message": "I want something to pair with springbok carpaccio"
  }'
```

Expected: `{"reply": "...specific wine name from the catalogue...", "metadata": {...}}`

Then in Supabase:
```sql
select role, content, metadata from conversations
where contact_id = 'test-1' order by created_at;
```
You should see one `user` row and one `assistant` row. Re-send the curl with the same `contact_id` and a follow-up question — Sarah should remember the previous turn.

Cross-channel check: send the same `contact_id` with `"channel": "whatsapp"` and confirm history is unified (the `Get History` node does not filter by channel).

---

## 5. Known gaps to close in the n8n UI

The imported workflow is the **happy path only**. After import, add:

1. **Error branch on Call Claude**: open the Claude node → Settings → **On Error: Continue (using error output)**. Wire the error output to a small chain: **HTTP Request** (POST to `conversations` with `role='system'`, `metadata.error=...`) → **Respond to Webhook** returning `{"reply":"Sorry — I'm having a moment. A human will be with you shortly."}`.
2. **Validate Extract**: optionally add an IF node after Extract that 400s if any of the four fields is empty.
3. **Tighten history filter**: if conversations get long, lower the `Get History` `limit` from 20.

These are deliberately left out of the JSON so the import is clean. Document any changes you make.

---

## 6. Verification checklist (from the plan)

- [ ] `select extname from pg_extension where extname='vector';` returns one row
- [ ] `select count(*) from wines where tenant_id = (select id from tenants where slug='level_24_wines');` equals the Shopify product count
- [ ] `search_wines` RPC returns 3 rows for a sample query embedding
- [ ] The curl test above returns a wine-grounded reply; user + assistant rows persist
- [ ] Follow-up message with the same `contact_id` shows multi-turn memory
- [ ] Error path (after you add it) returns a 200 fallback + `role='system'` error row
- [ ] Editing `prompts/sarah.md` + pushing to `main` updates `prompts.content` in Supabase
- [ ] `git grep -E "sk-(ant|live|test)|pa_live|shpat_"` from repo root returns zero matches

---

## 7. What comes after Step 2

- **Step 3 (GHL)**: route inbound channel messages → this webhook → reply back via GHL's `/conversations/messages` API. Use `contact.id` from GHL as the `contact_id` here for cross-channel continuity. See the platform plan for the full sketch.
- **Step 4 (Shopify tool-use)**: add `search_wines` / `check_stock` / `add_to_cart` tools to the Claude call, route tool-use stops through a Switch node, persist `cart.id` in a new `customer_carts` table.
