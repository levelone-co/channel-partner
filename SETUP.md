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
   - `sql/0003_wines_variant_grained.sql` — switches `wines` to one row per Shopify *variant* (so individual vintages are tracked separately) and adds `shopify_variant_id` to the RPC return columns.
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
5. **Product data layout the ingestion script expects:**
   - **Product category** = "Food & beverage › Alcoholic beverages › Wine" (unlocks the Shopify standard `shopify.wine-variety`, `shopify.wine-sweetness`, `shopify.country`, `shopify.region` metafields).
   - **Product type** = "Red Wine" / "White Wine" / "Port" / etc.
   - **Vintage** = a Product **Variant** option named "Vintage" with values like "2019", "2020". Each variant has its own SKU, price, and inventory. (Single-vintage wines can skip the option and rely on the `custom.vintage` fallback metafield.)
   - **Custom Metafield definitions** to create at Settings → Custom data → Products → Add definition:
     - `custom` · `varietal` — Multi-line text. Authoritative for grape composition (single variety or blend, e.g. "Cabernet Sauvignon 60%, Merlot 40%"). Takes precedence over the Shopify standard `shopify.wine-variety` if both are populated.
     - `custom` · `range` — Single-line text. e.g. "Twenty Four", "Level".
     - `custom` · `pairings` — Multi-line text.
     - `custom` · `awards` — Multi-line text.
   - Vintage is captured as a Shopify **Variant option** (not a metafield) — the script reads the variant's option value automatically.
   - **Tags** are consumed as-is and folded into the wine's description.

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
- [ ] `select count(*) from wines where tenant_id = (select id from tenants where slug='level_24_wines');` equals the **variant** count across all Shopify wine products (one row per vintage, not per product)
- [ ] `search_wines` RPC returns 3 rows for a sample query embedding
- [ ] The curl test above returns a wine-grounded reply; user + assistant rows persist
- [ ] Follow-up message with the same `contact_id` shows multi-turn memory
- [ ] Error path (after you add it) returns a 200 fallback + `role='system'` error row
- [ ] Editing `prompts/sarah.md` + pushing to `main` updates `prompts.content` in Supabase
- [ ] `git grep -E "sk-(ant|live|test)|pa_live|shpat_"` from repo root returns zero matches

---

## 7. Step 3 — GHL channel routing

Wire real customers (web chat / WhatsApp / SMS / email) through the existing n8n webhook.

### 7.1 GHL custom fields

In the sub-account → **Settings → Custom Fields → Contact → Add field**. Create these four (the original five-field list dropped `return_channel_declined` after we pivoted to conversational-only capture):

| Display name | API key | Type | Used by |
|---|---|---|---|
| AI paused | `ai_paused` | Single option (Yes/No) | GHL workflow filter — skip n8n when Yes |
| WhatsApp preferred | `whatsapp_preferred` | Single option (Yes/No) | Set Yes by silent extractor when WhatsApp differs from primary phone |
| Return channels captured at | `return_channels_captured_at` | Date | Timestamp of last enrichment |
| Last wines discussed | `last_wines_discussed` | Multi-line text | Comma-separated wine titles from last conversation |
| Team notes | `team_notes` | Multi-line text | JSON-formatted array, written by the `team-reply` workflow when the Slack team replies to `consult_team` |

After creation, copy each field's **field ID** (visible on the field edit page). You'll plug these into the workflow's `Get Contact` and `Update GHL Contact` nodes.

### 7.2 Private Integration token

Sub-account → **Settings → Private Integrations → Create Integration**. Scopes:

- `contacts.readonly` + `contacts.write`
- `conversations.readonly` + `conversations.write`
- `conversations/message.write`
- `locations.readonly`

Reveal the token once (starts `pit-`) → in n8n add Variable **`GHL_API_TOKEN`** with the value.

Also capture the sub-account **location ID** from your URL bar (`app.gohighlevel.com/v2/location/<location_id>/...`). Add it as n8n Variable **`GHL_LOCATION_ID`**, then run `sql/0004_tenants_ghl_location.sql` after replacing the placeholder with the real value.

### 7.3 Inbound: GHL Workflow → n8n

Create a workflow in GHL:

- **Trigger**: *Customer Replied* (all channels).
- **Filter**: `Contact → Custom Field → AI paused → is not Yes`.
- **Action: Webhook**:
  - Method: POST
  - URL: `https://level24co.app.n8n.cloud/webhook/ai-conversation`
  - Body (JSON, paste exactly — GHL replaces the `{{...}}` merge fields):
    ```json
    {
      "tenant_slug": "level_24_wines",
      "contact_id": "{{contact.id}}",
      "channel": "{{message.type}}",
      "message": "{{message.body}}"
    }
    ```

### 7.4 Outbound + tool-loop + extraction (n8n UI changes)

See **`STEP3_N8N_CHANGES.md`** for click-by-click n8n changes. Summary: channel normalisation in `Extract`, new `Get Contact` node, new `Send via GHL` node, new parallel `Extract Entities` branch with `Update GHL Contact`, new tool-loop after `Call Claude` for the seven tools in `tools/account-tools.json`.

### 7.5 Embed the chat widget on the storefront

- Widget type: **Live chat** (not All-in-One — that pulls in the Meta-gated WhatsApp channel). Name it "Sarah". **Do not enable GHL's built-in Conversation AI** — our n8n + Claude pipeline is the brain, triggered via the *Customer Replied* workflow. Two AIs on one widget = double replies.
- GHL sub-account → **Sites → Chat Widget** → copy the embed snippet.
- Shopify admin → **Online Store → Themes → ⋯ → Edit code → `layout/theme.liquid`** → paste before `</body>`. Save.
- The bubble appears bottom-right on every page. First customer message creates a GHL contact and fires the workflow.

Deployed widget snippet (Level 24 demo sub-account):

```html
<script src="https://widgets.leadconnectorhq.com/loader.js" data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js" data-widget-id="6a072ec62a4bbd9f1746f45d"></script>
```

Widget ID `6a072ec62a4bbd9f1746f45d`. The widget ID is not secret (it ships in client-side HTML); recorded here for reproducibility / handoff.

### 7.6 Verification — Step 3

1. Visit `https://level-24-co.myshopify.com/` → click chat bubble → ask "what pairs with steak?" → Sarah replies in the widget. Check GHL inbox + Supabase `conversations` for the rows.
2. WhatsApp the Level 24 number from a test phone → Sarah replies on WhatsApp.
3. Cross-channel: same contact across web + WhatsApp → Sarah's history is unified.
4. Silent capture: in a conversation, volunteer *"I'm Joe, you can WhatsApp me on 0821234567 about new releases"*. Check GHL: `firstName=Joe`, `phone=+27821234567`, `whatsapp_preferred=Yes`, `return_channels_captured_at` populated. Sarah's reply should not awkwardly thank you for the info.
5. No-solicitation discipline:
   ```sql
   select count(*) from conversations
   where role='assistant'
     and content ~* '(what is your|can i have your|what.s your|please share your) (phone|email|number|whatsapp|contact)';
   ```
   Expect 0.
6. Operator handoff: in GHL inbox, set the contact's `ai_paused=Yes`. Send another message → n8n webhook does NOT fire (no new Supabase rows). Toggle back to No → next message goes through Sarah.

## 8. Step 3.5 — Sarah's consultation toolkit

After Step 3 verifies, add Sarah's three consultation tools (`consult_web`, `consult_knowledge_base`, `consult_team`).

### 8.1 Tavily (web search)

Sign up at https://app.tavily.com (free tier: 1000 searches/month). Generate an API key → add as n8n Variable **`TAVILY_API_KEY`**.

### 8.2 Knowledge base — schema + ingest

Run `sql/0005_knowledge_base_and_consultation.sql` in the Supabase SQL Editor. Verify:

```sql
select count(*) from knowledge_base;                                  -- 0 initially
select column_name from information_schema.columns
  where table_name = 'tenants' and column_name = 'slack_webhook_url';  -- 1 row
```

Author/edit `.md` files in `knowledge_base/level_24_wines/` (the README in that folder explains the convention). Then locally:

```bash
source .venv/bin/activate
python scripts/ingest_knowledge.py --tenant level_24_wines
```

Re-run after every change. The script clears + replaces all rows for the tenant.

### 8.3 Slack incoming webhook for `consult_team`

In Slack workspace → **Apps → Incoming Webhooks** (install if not present) → **Add to Slack** → pick a channel (e.g. `#level-24-sarah`) → **Add Incoming WebHooks integration** → copy the URL (`https://hooks.slack.com/services/T.../B.../...`).

Store it per-tenant in Supabase:

```sql
update tenants
   set slack_webhook_url = 'https://hooks.slack.com/services/...'
 where slug = 'level_24_wines';
```

(Stored in the DB, not in n8n Variables, so the right webhook is selected automatically per `tenant_slug` when `consult_team` fires.)

### 8.4 Workflow changes for the consultation tools

See **`STEP3_N8N_CHANGES.md`** §"Step 3.5 — Consultation tools" for the tool-loop additions.

### 8.5 The resumption workflow (`team-reply`)

A separate n8n workflow handles Slack team replies → contact's `team_notes`. Trigger options:

- **Easiest**: a GHL Internal Note creation event (operator manually posts the team's reply into the GHL contact's internal notes; an upstream workflow listens for the note and runs the resumption).
- **More automated**: Slack outgoing webhook on the channel — fires every message in the Slack channel; n8n filters by author + parses the message.

For Phase 0 demo, go with the GHL Internal Note path: less wiring, less moving parts. Documented in `STEP3_N8N_CHANGES.md`.

### 8.6 Verification — Step 3.5

1. **Web research**: ask Sarah a question outside the catalogue (e.g. "what did Tim Atkin write about SA Pinotage in 2025?"). Verify she calls `consult_web` and folds the result into her reply.
2. **Knowledge base**: ask "what time does the tasting room open?". Verify she calls `consult_knowledge_base`, retrieves from `visiting-and-shipping.md`, and answers correctly ("daily 10:00–17:00").
3. **Team consult**: ask something niche ("can you ship to Mauritius next Thursday?"). Verify: (a) a Slack message appears in the configured channel with the question, (b) Sarah's reply keeps the conversation moving (no stalling), (c) when the team replies via GHL Internal Note, the next customer turn references the team's answer naturally.
4. **No-stall discipline**:
   ```sql
   select count(*) from conversations
   where role='assistant'
     and content ~* '(let me get back to|give me a moment|i.ll find out|hold on while|i.ll confirm)';
   ```
   Expect 0 in the consult_team test runs.

## 9. Step 4 — Shopify cart tools

Sarah can `search_wines` / `check_stock` / `add_to_cart` and hand the customer a real checkout URL. Implemented as a single agent-loop Code node (`workflows/sarah-agent-loop.js`) replacing the `Call Claude` HTTP node — no fragile n8n cycle.

Full click-by-click in **`STEP4_N8N_CHANGES.md`**. Summary:

1. Run `sql/0006_customer_carts.sql` in Supabase.
2. Create/confirm the Storefront API token (`shpss_…`) and its scopes; set n8n Variables `SHOPIFY_STORE_DOMAIN` + `SHOPIFY_STOREFRONT_TOKEN`.
3. Replace the `Call Claude` HTTP node with a Code node (same name) holding `workflows/sarah-agent-loop.js`, mode **Run Once for All Items**.
4. Verify search/stock/cart per `STEP4_N8N_CHANGES.md` §6, then export → commit.

The agent loop owns the tool dispatch internally: `search_wines` (Voyage embed + `search_wines` RPC), `check_stock` + `add_to_cart` (Shopify Storefront GraphQL, cart persisted in `customer_carts`), `capture_return_channels` (GHL PUT). Returns the final Anthropic response in the same shape the old HTTP node did, so `Log Assistant Turn` / `Send via GHL` / `Respond` are untouched.

## 10. What comes after Step 4

- **Voiceflow eval** (parallel platform comparison): build the same Sarah in Voiceflow, compare quality / latency / prompt ergonomics / cost / lock-in. Deferred until Step 4 is verified.
- Phase 1 backlog items live in `PROJECT.md` (intent router, streaming, parallel fetches, WhatsApp templates for proactive nurture, All-in-One/Voice follow-up, etc.).
