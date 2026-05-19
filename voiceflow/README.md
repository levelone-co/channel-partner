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
`fn_consult_web`, `fn_consult_knowledge_base`, `fn_consult_team`. Their
bodies are in `functions/tools.js` (one exported handler each — split into
separate VF Functions, sharing the `functions/_http.js` helper inline).

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
