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
bubble — this is the main way to actually evaluate VF voice. Project must be
**Published → Production** or the bubble never appears. The current live
snippet (in Shopify `layout/theme.liquid`, before `</body>`, with the GHL
loader commented out) is the voice form — keep the `voice:` block and add
`versionID`:

```html
<script type="text/javascript">
  (function(d, t) {
    var v = d.createElement(t), s = d.getElementsByTagName(t)[0];
    v.onload = function() {
      window.voiceflow.chat.load({
        verify: { projectID: '69fb1aaa5cd3c58960585794' },
        url: 'https://general-runtime.voiceflow.com',
        versionID: 'production',
        voice: { url: 'https://runtime-api.voiceflow.com' }
      });
    };
    v.src = 'https://cdn.voiceflow.com/widget-next/bundle.mjs';
    v.type = 'text/javascript'; s.parentNode.insertBefore(v, s);
  })(document, 'script');
</script>
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

## 6. Operator step — reproducible build details (Agentic builder)

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
