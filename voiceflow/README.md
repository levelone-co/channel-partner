# Voiceflow build runbook — full-parity "Sarah"

This is the executable spec for rebuilding Sarah in the Voiceflow studio for
the `eval/voiceflow` comparison. It is **functionally identical** to the n8n
path (`workflows/ai-conversation-core.json` + `sarah-agent-loop.js`) and
obeys the same migration rules: prompts read from Supabase, history written
to the same Supabase `conversations` table, tools from
`tools/account-tools.json`, RAG on the same Supabase pgvector — **Voiceflow's
native Knowledge Base is NOT used**.

Build it *idiomatically* (visual flow + Agent step + Functions). Do **not**
paste `sarah-agent-loop.js` into one mega-Function — the whole point of the
"prompt-editing ergonomics" dimension is to exercise the studio.

> **Operator decision: this VF project is a VOICE assistant** (Chat/Voice is
> a binary choice at project creation). The Functions
> (`bootstrap`/`tools`/`finalize`) are modality-agnostic and unchanged. The
> consequences for the eval are recorded in `eval/rubric/quality-rubric.yaml`
> (cross-modality notice) and `eval/README.md`: n8n=text vs VF=voice is NOT
> an apples-to-apples head-to-head, so the text harness is retained only as
> a **functional-parity probe** of the voice project, and voice quality /
> perceived latency / Phase-1 voice-readiness are scored from the **live
> voice build**, not docs.

## 0. Account + secrets

Free/sandbox account. In **Voiceflow → project → Integrations / API keys**,
get the **Dialog Manager API key** → store it as n8n Variable
`VF_DM_API_KEY` (the adapter uses it; see `.env.example`).

In **Voiceflow → Secrets store**, add (these mirror the n8n Variables the
JS uses). `TAVILY_API_KEY` is optional — `fn_consult_web` degrades
gracefully without it (footnote consult_web as "not exercised" in the
report).

| Secret | Source |
|---|---|
| `ANTHROPIC_API_KEY` | same key as n8n |
| `SUPABASE_URL` | same |
| `SUPABASE_SERVICE_ROLE_KEY` | same |
| `VOYAGE_API_KEY` | same |
| `SHOPIFY_STORE_DOMAIN` | same (`level-24-co.myshopify.com`) |
| `GHL_API_TOKEN` | same |
| `TAVILY_API_KEY` | optional (consult_web) — free key at app.tavily.com |

### Variables — reuse built-ins; create only the customs

`vf_` is reserved by Voiceflow, so plumbing variables use the **`fv_`**
prefix. Reuse these built-ins instead of custom equivalents:

| Built-in | Use as | Don't create |
|---|---|---|
| `last_utterance` | the user's message | ~~`message`~~ |
| `user_id` | the contact id (VF userID) | ~~`contact_id`~~ |
| `last_response` | agent's reply (→ finalize) | ~~`reply_text`~~ |

Custom variables to create (also in `voiceflow/variables.json` for import):
`tenant_slug`, `channel`, `fv_system_text`, `fv_messages`,
`fv_tenant_id`, `fv_retrieved_wine_ids`, `path`. Do **not** use `vf_memory`
for history — it's session-scoped; parity history comes from Supabase via
`bootstrap` (`fv_messages`).

**Free-tier caveats — record these in the eval report, do not silently
absorb them:**
- Dialog Manager API has a monthly interaction quota — batch the blind runs
  to stay under it, or note the cap as a limitation.
- Functions have an invocation/runtime ceiling and an outbound-fetch
  allowlist; 8 tools × loop iterations multiplies calls.
- If the hosted LLM step is token-capped on free tier, drive Claude through
  a Function with our own `ANTHROPIC_API_KEY` (the `callClaude` port) rather
  than the native model — the build below already does this so the engines
  are LLM-identical.

## 1. Flow topology

```
Start
  → [Function] bootstrap        (functions/bootstrap.js)
  → [Agent step] "Sarah"        Claude Haiku, system = {fv_system_text},
                                 8 tools, each fulfilled by a Function below,
                                 max tool iterations ≈ 5
  → [Function] finalize         (functions/finalize.js)
  → End (agent already spoke; finalize just logs + extracts)
```

Tool Functions (registered on the Agent step, one per tool in
`tools/account-tools.json`): `fn_search_wines`, `fn_check_stock`,
`fn_add_to_cart`, `fn_set_cart`, `fn_capture_return_channels`,
`fn_consult_web`, `fn_consult_knowledge_base`, `fn_consult_team`.

**Every file in `voiceflow/functions/` (the 8 `fn_*` + `bootstrap` +
`finalize`) is PASTE-READY BODY ONLY.** The Voiceflow function creator
already supplies the `export default async function main(args) { … }`
wrapper — paste the file's contents *between its braces*. Do not add
`export default`, an outer function, or `module.exports`. The `http` helper
(and `sbHeaders` where needed) is inlined in each file because VF Functions
cannot import shared modules.

The Agent step **runs the tool-loop natively** — that is Voiceflow's
idiomatic equivalent of the JS `for (iter < MAX_ITERS)` loop. Register each
tool's schema (copy verbatim from `tools/account-tools.json`) and wire its
fulfilment to the matching Function.

## 2. Inputs

The adapter (`workflows/vf-adapter.json`) PATCHes user-state variables
before `/interact`, so at flow start `tenant_slug` and `channel` exist;
the contact id is the built-in `user_id` (= VF userID) and the message is
the built-in `last_utterance`. For the live voice-widget path there is no
adapter, so `bootstrap` defaults `tenant_slug='level_24_wines'`,
`channel='web'`.

## 3. What each Function does (parity contract)

- **bootstrap** — Get Tenant id (`tenants?slug=eq`), Get Contact (GHL),
  Get Prompts (`prompts?name=in.(10,15,20,30,40)` ordered by name), Get
  History (`conversations …limit 20`, reversed to chronological), Voyage
  embed of the message + `search_wines` RPC, assemble the `system` string
  (concatenated prompts + contact-context + retrieved-wine block, identical
  format to n8n `Build Messages`) and the `messages` array, then write the
  **Log User Turn** row. Sets VF vars: `fv_system`, `fv_system_text`,
  `fv_messages`, `fv_tenant_id`, `fv_retrieved_wine_ids`.
- **fn_*** — exact ports of the `sarah-agent-loop.js` handlers (cart still
  zero-auth permalink + `customer_carts` keyed `(tenant_id, contact_id)`;
  consult_* built from `STEP3_N8N_CHANGES.md` §3.5: Tavily / Voyage +
  `search_knowledge_base` RPC / Slack from `tenants.slack_webhook_url`).
- **finalize** — write the **Log Assistant Turn** row (same metadata shape +
  `metadata.engine='voiceflow'`, `metadata.path` = 'adapter' | 'widget'),
  then run the silent-extraction step (cheap Haiku extraction → GHL PUT,
  port of the n8n `Extract Entities`/`Update GHL Contact` branch). Returns
  the reply text to the flow.

Team-reply resumption needs **no VF work** — the existing n8n `team-reply`
workflow writes `team_notes` onto the GHL contact; `bootstrap`'s Get Contact
picks it up next turn exactly as the n8n path does.

## 4. Voice widget path (primary VF tester)

Because this is a **Voice** assistant, the widget renders as a voice/call
bubble. Project must be **Published → Production** or the bubble never
appears.

**Cost discipline (voice ≈ $0.50/convo — mostly TTS/STT): never debug logic
on voice.** Test order: (1) Voiceflow Run/Test panel (text, ~cents) for
grounding/cart/brevity; (2) text harness `eval/runner/run_eval.py` via
`vf-adapter` for the functional-parity gates; (3) live voice widget
`?vf=1` only for the final qualitative voice-readiness pass.

Storefront gate (v2 — GHL stays static; Voiceflow + CSS-hide only on
`?vf=1`). The earlier dynamic-inject GHL pattern broke the bubble because
LeadConnector's `loader.js` reads `data-widget-id` via `document.currentScript`,
which is unreliable for scripts created via `createElement`+`appendChild`.
Keep GHL exactly as it was (static `<script>`) and only inject Voiceflow on
`?vf=1`, hiding the GHL bubble in that mode.

```html
{% raw %}
{% if settings.quick_add or settings.mobile_quick_add %}
  {% render 'quick-add-modal' %}
{% endif %}

<!-- GHL widget — STATIC, deferred, with id so the gate can cancel it on ?vf=1. -->
{% # theme-check-disable RemoteAsset %}
<script defer id="ghl-loader"
        src="https://widgets.leadconnectorhq.com/loader.js"
        data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js"
        data-widget-id="6a072ec62a4bbd9f1746f45d"></script>
{% # theme-check-enable RemoteAsset %}

<!-- Voiceflow — only when ?vf=1 (sticky; ?vf=0 resets); hides GHL bubble in that mode -->
<script>
  (function () {
    var p = new URLSearchParams(window.location.search), vf;
    try {
      if (p.get('vf') === '1') sessionStorage.setItem('useVF', '1');
      if (p.get('vf') === '0') sessionStorage.removeItem('useVF');
      vf = sessionStorage.getItem('useVF') === '1';
    } catch (e) { vf = p.get('vf') === '1'; }
    if (!vf) return;

    // Cancel the deferred GHL loader BEFORE it executes (defer queues
    // execution until after parse; removing the element cancels it).
    var ghl = document.getElementById('ghl-loader');
    if (ghl) ghl.remove();

    // Belt-and-braces: hide anything that still renders.
    var style = document.createElement('style');
    style.textContent =
      'iframe[src*="leadconnectorhq.com"],iframe[src*="msgsndr"],' +
      '#chat-widget-container,#chat-widget,[id^="chat-widget"],' +
      '[id*="leadconnector"],[class*="leadconnector"]{display:none!important;}';
    document.head.appendChild(style);
    var v = document.createElement('script');
    v.onload = function () {
      window.voiceflow.chat.load({
        verify: { projectID: '69fb1aaa5cd3c58960585794' },
        url: 'https://general-runtime.voiceflow.com',
        versionID: 'production',
        voice: { url: 'https://runtime-api.voiceflow.com' }
      });
    };
    v.src = 'https://cdn.voiceflow.com/widget-next/bundle.mjs';
    v.type = 'text/javascript';
    document.body.appendChild(v);
  })();
</script>
{% endraw %}
```

Logging still happens inside the same `bootstrap`/`finalize` Functions, so
voice conversations land in Supabase with `metadata.engine='voiceflow'`,
`metadata.path='widget'` — no extra plumbing. The widget path has no
`tenant_slug`/`channel` from an adapter, so `bootstrap` defaults
`tenant_slug='level_24_wines'`, `channel='web'` when the VF vars are absent.
Use the live voice widget to score the `phase1_voice_readiness` sub-criterion
(turn-taking, perceived latency, do tools fire in voice, grounding).

## 5. Verification

Two distinct activities (Voice-only build):

1. **Functional-parity probe (automated, text).** `eval/runner/run_eval.py`
   still drives the VF voice project via `vf-adapter.json` with text
   `interact` — most VF voice projects accept text and return text traces.
   Purpose is NOT latency/quality comparison; it's a parity check: does VF
   ground in catalogue, fire tools, write `conversations` rows with
   `metadata.engine='voiceflow'`, and pass the no-solicitation / no-stall
   SQL gates in `eval/README.md` for `eval-vf-*` contacts. VF latency from
   this probe is excluded from latency scoring (text != voice).
2. **Live voice assessment (manual).** Use the published voice widget on the
   site to score `phase1_voice_readiness` and qualitative voice quality /
   perceived responsiveness. This is the real VF-voice evidence.

n8n remains the text baseline. The final report states a recommendation
WITH the explicit n8n=text vs VF=voice cross-modality caveat (see
`eval/rubric/quality-rubric.yaml`).

## 5b. Voiceflow Function wiring — HARD RULES (learned from testing)

A failed first run (`bootstrap failed 1ms`, `{"error":{"varName":"VOYAGE_API_KEY"}}`,
`fv_system_text: 0`, Operator falling back to Voiceflow's default persona)
proved three non-obvious Voiceflow Function-tool rules. The function code
now complies; you must do the wiring side:

1. **Every external variable must be a direct `args.X`.** Voiceflow only
   surfaces an input if it sees `args.NAME` literally (an `const env=args`
   alias is invisible to its analyzer, and its runtime throws
   `{"error":{"varName":"NAME"}}` the instant the code touches an
   unprovided var). All functions were refactored to declare each secret as
   `const NAME = args.NAME;` at the top — so Voiceflow now lists them all.
2. **Secrets are NOT auto-injected.** Each detected input must be **Added**
   and given a value: secrets → map to the Secrets store entry of the same
   name; `tenant_slug`/`channel` → the variable; `user_id`/`last_utterance`
   /`last_response` → the built-ins; `fv_tenant_id` → the variable set by
   bootstrap. Agent-collect ON only for the real tool args.
3. **Outputs must be Saved.** Function returns a FLAT object; each top-level
   key is an output you must **Save to a variable** (same name). Tools
   return `{ tool_result }` → save to `fv_tool_result` (the `outputVars`
   wrapper was removed — Voiceflow reads top-level keys). bootstrap returns
   `fv_system_text` etc. → save each, especially **`fv_system_text`** (if
   not saved it stays 0 and the Operator has no prompt → default persona).

After ANY code change here: re-paste the body into the VF function, then
re-Add inputs / re-Save outputs (mappings don't survive a code swap), then
**Publish → Production** before testing the widget.

## 5c. Behaviour + cost tuning (post first-run)

First successful voice run was verbose, ungrounded, and didn't add to cart.
Fixes applied in code (`bootstrap.js`):
- **Brevity + grounding + cart** enforced via a VF-only operator addendum
  appended to `fv_system_text` (one spoken sentence; never name a wine not
  returned by fn_search_wines this conversation; cart needs a same-turn
  tool call; don't read URLs aloud).
- **Channel defaults to `voice`** (widget path) so the behavioural
  prompt's voice length rule applies; the adapter still overrides for the
  text probe.
- **Removed the launch-time Voyage embed + search_wines** from bootstrap —
  it ran on an empty message (`"featured wines"` junk in your log), cost a
  Voyage call every session, and is redundant: RAG is the
  `fn_search_wines` tool's job in the Operator architecture.

Operator-side settings to do (cost + brevity):
- **Max response tokens** ≈ 120–160 — hard-caps voice length AND output
  cost (output tokens dominate spend).
- **Disable tools not needed for the demo** (`fn_consult_web`,
  `fn_consult_knowledge_base`, `fn_consult_team`) — fewer tools = fewer
  agent loop iterations = less spend (your log showed ~$0.0029 per
  Operator AI result; each tool round-trip adds one).
- Confirm the Operator model is **Claude Haiku** (cheapest capable).
- Keep MAX agent iterations low (≈3–4).
- Note: Voiceflow flattens the system prompt so Anthropic prompt-caching
  is lost — documented eval cost caveat, not fixable in VF.

**Voice cart caveat (expected, not a bug to chase):** the cart is a
zero-auth Shopify *permalink* — there's no on-site cart to inspect, and a
URL can't be spoken. "Nothing in my cart" is therefore expected on voice;
the correct check is whether `fn_add_to_cart` ran and a row exists:
`select * from customer_carts where contact_id = '<your user_id>';`
For the eval this is a known voice limitation (logged as a caveat); the
functional gate is the tool firing + the customer_carts row, not an
on-site cart.

## 6. Operator step — reproducible build details (Agentic builder)

**Workflow ("Agent Flow") LLM description** (routing/purpose blurb — NOT the
system prompt, which stays `{fv_system_text}`):

> Handles every customer conversation for Level 24 Wines as Sarah, the
> estate's voice wine concierge. Use for anything wine-related:
> recommendations by taste, food pairing, occasion or budget; checking
> stock; building and modifying the customer's cart and giving them a
> checkout link; answering questions about the wines, the estate, visiting
> and shipping; and researching external wine context when needed. Also
> silently captures any contact details the customer volunteers, without
> ever asking for them. Default workflow for all inbound conversations.

Topology (one Operator, not two):
`Start → bootstrap → Operator "Sarah" → finalize → End conversation`.

- **Prompt field:** `{fv_system_text}` (the layered Supabase prompt from
  bootstrap — do not hand-type the persona).
- **Model:** Claude Haiku if selectable; else nearest Claude → record model
  delta as an eval caveat.
- **Opening / greeting (Voice needs one — no visible UI):** one short,
  on-brand, non-soliciting line, e.g.
  *"Hi, I'm Sarah from Level 24 Wines — what are you in the mood for today?"*
- **End message:** leave blank (Sarah's last reply stands; finalize is
  silent). Optional brief sign-off only if the customer is clearly done
  ("Enjoy the wine — cheers!"). Never solicit in the end message.
- **Exit condition** `reply_delivered` — LLM description: *"Exit when you
  have given the customer a complete reply for their current request — a
  recommendation, an answer, or a cart confirmation — and there is nothing
  further to do this turn."* Required variables: none.

### Tool execution model
All 8 tools are **synchronous** — each returns a `tool_result` the agent
needs the same turn. Do NOT mark any as background/async. The only
asynchronous hop is `consult_team`'s human reply, handled out of band by
the `team-reply` workflow → GHL `team_notes` → `bootstrap` next turn
(no VF async setting). `finalize` runs after the Operator already spoke,
so it adds no customer-perceived latency.

### Tool LLM descriptions (paste verbatim; faithful to tools/account-tools.json)

- **fn_search_wines** — Search the wine catalogue by intent or attribute.
  Call whenever the customer expresses any preference — varietal, price
  range, food pairing, occasion, or mood. Returns top matches with title,
  varietal, vintage, price, pairings, awards, and the variant_id for
  stock/cart.
- **fn_check_stock** — Check live stock for a specific wine VARIANT before
  adding to cart. Call if there's any doubt it's available. Requires the
  shopify_variant_id from the retrieved wines.
- **fn_add_to_cart** — Incrementally add a wine variant to the customer's
  prepared cart and return a checkout link. Call ONLY after explicit
  confirmation ("yes", "add it", "sure"). Use for "add another"/"also add".
- **fn_set_cart** — Replace the customer's ENTIRE cart with exactly the
  given items in one call. Use for any remove/replace/change-quantity/clear
  ("make it just 2 Shiraz", "empty my cart" → items:[]). Returns the
  updated checkout link.
- **fn_capture_return_channels** — Backup acknowledgment only. Call when
  the customer has just unmistakably volunteered name/phone/WhatsApp/email
  AND your reply will reference it. NEVER call to ask for contact details;
  never solicit.
- **fn_consult_web** — Search the public web for things outside the
  catalogue and prompts — external critic reviews (Tim Atkin, Decanter),
  SA wine-industry context, producer news, awards not in our list. Never
  for in-catalogue questions.
- **fn_consult_knowledge_base** — Search the estate's internal knowledge
  base (winemaker notes, FAQ, tasting events, estate history, visiting/
  shipping info) for account-specific questions not covered by the
  catalogue or your instructions.
- **fn_consult_team** — Post a question to the estate team via Slack ONLY
  when it's genuinely beyond your knowledge and you've already tried
  consult_web and consult_knowledge_base. Their reply arrives a later
  turn. Do not pause or stall — keep selling with what you know.

### Tool INPUT variables — source + LLM description

Each tool input is one of two kinds. Getting the source wrong is what
triggers Voiceflow's "Missing input variable LLM description" error.

- **LLM-supplied args** (the tool's input_schema fields) → source = **LLM**,
  give each the description below.
- **System-injected** (`fv_tenant_id`, `user_id`, `tenant_slug`, and the
  secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`,
  `SHOPIFY_STORE_DOMAIN`, `GHL_API_TOKEN`, `TAVILY_API_KEY`) → source =
  **Variable / Secret**, NOT LLM. No LLM description (and must not be
  LLM-inferred). If any of these are left as "LLM", the error persists.

LLM-arg descriptions:

- `fn_search_wines.query` — Free-text of what the customer wants: varietal,
  price range, food pairing, occasion or mood.
- `fn_check_stock.shopify_variant_id` — Shopify VARIANT id of the specific
  wine+vintage, from the retrieved wines. Never say it aloud.
- `fn_add_to_cart.shopify_variant_id` — Shopify VARIANT id of the wine+
  vintage being added.
- `fn_add_to_cart.quantity` — Bottles, integer 1–24; default 1 unless the
  customer specifies.
- `fn_set_cart.items` — COMPLETE desired final cart: array of
  {shopify_variant_id, quantity}; empty array clears it; include every
  item that should remain, not just the change.
- `fn_capture_return_channels.first_name|last_name|phone|whatsapp|email` —
  all optional; fill ONLY what the customer volunteered, never guess.
  Phone/whatsapp in E.164 if inferable (SA 0821234567 → +27821234567).
- `fn_consult_web.query` — Concise web search query for the external info
  needed.
- `fn_consult_knowledge_base.query` — Concise query for the estate-specific
  info needed.
- `fn_consult_team.question` — Concise question for the team with enough
  customer context to answer.

### Full tool × input matrix (Voiceflow requires a description on EVERY input)

System/secret inputs (Agent collect = OFF) — reuse one of:
- `fv_tenant_id` → "Internal tenant UUID from bootstrap. Not user-facing —
  never ask the customer, never invent it."
- `user_id` → "Internal session/contact id, injected automatically. Not
  user-facing — never ask the customer, never invent it."
- `tenant_slug` → "Internal tenant slug, injected automatically. Not
  user-facing — never ask the customer, never invent it."
- any secret (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`,
  `SHOPIFY_STORE_DOMAIN`, `GHL_API_TOKEN`, `TAVILY_API_KEY`) → "System
  credential/configuration from the Secrets store. Never ask the customer,
  never reveal or repeat it, never invent it."

Agent-collect = ON inputs per tool (descriptions in the list above):
- fn_search_wines: query | OFF: fv_tenant_id, SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY
- fn_check_stock: shopify_variant_id | OFF: fv_tenant_id, SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
- fn_add_to_cart: shopify_variant_id, quantity | OFF: fv_tenant_id,
  user_id, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_STORE_DOMAIN
- fn_set_cart: items | OFF: fv_tenant_id, user_id, SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_STORE_DOMAIN
- fn_capture_return_channels: first_name, last_name, phone, whatsapp,
  email (all optional, volunteered only) | OFF: user_id, GHL_API_TOKEN
- fn_consult_web: query | OFF: TAVILY_API_KEY
- fn_consult_knowledge_base: query | OFF: fv_tenant_id, SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY
- fn_consult_team: question | OFF: tenant_slug, user_id, SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY

Every tool: output `tool_result` → save to variable `fv_tool_result`;
Async execution = OFF.
