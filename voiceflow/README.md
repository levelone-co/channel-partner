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

## 0. Account + secrets

Free/sandbox account. In **Voiceflow → project → Integrations / API keys**,
get the **Dialog Manager API key** → store it as n8n Variable
`VF_DM_API_KEY` (the adapter uses it; see `.env.example`).

In **Voiceflow → project → Settings → Variables / Secrets**, add (these
mirror the n8n Variables the JS uses):

| Secret | Source |
|---|---|
| `ANTHROPIC_API_KEY` | same key as n8n |
| `SUPABASE_URL` | same |
| `SUPABASE_SERVICE_ROLE_KEY` | same |
| `VOYAGE_API_KEY` | same |
| `SHOPIFY_STORE_DOMAIN` | same (`level-24-co.myshopify.com`) |
| `GHL_API_TOKEN` | same |
| `TAVILY_API_KEY` | same (consult_web) |

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
  → [Agent step] "Sarah"        Claude Haiku, system = {vf_system},
                                 8 tools, each fulfilled by a Function below,
                                 max tool iterations ≈ 5
  → [Function] finalize         (functions/finalize.js)
  → End (return {vf_reply})
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
before `/interact`, so at flow start these VF variables exist:
`tenant_slug`, `contact_id`, `channel`. `bootstrap` reads them, plus the
user's message from the incoming `request.payload`.

## 3. What each Function does (parity contract)

- **bootstrap** — Get Tenant id (`tenants?slug=eq`), Get Contact (GHL),
  Get Prompts (`prompts?name=in.(10,15,20,30,40)` ordered by name), Get
  History (`conversations …limit 20`, reversed to chronological), Voyage
  embed of the message + `search_wines` RPC, assemble the `system` string
  (concatenated prompts + contact-context + retrieved-wine block, identical
  format to n8n `Build Messages`) and the `messages` array, then write the
  **Log User Turn** row. Sets VF vars: `vf_system`, `vf_messages`,
  `vf_tenant_id`, `vf_retrieved_wine_ids`, `vf_message`.
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

## 4. Native widget path (second integration tested)

On a **staging Shopify theme** (or behind a `?vf=1` query-param gate so it
never collides with the live GHL `Live chat` widget, id
`6a072ec62a4bbd9f1746f45d`), paste the Voiceflow web-chat embed before
`</body>` and set the user id + context:

```html
<script type="text/javascript">
  (function(d, t) {
    var v = d.createElement(t), s = d.getElementsByTagName(t)[0];
    v.onload = function() {
      window.voiceflow.chat.load({
        verify: { projectID: 'YOUR_VF_PROJECT_ID' },
        url: 'https://general-runtime.voiceflow.com',
        versionID: 'production',
        user: { userID: 'eval-vf-web-' + (window.crypto?.randomUUID?.() || Date.now()) }
      });
    };
    v.src = 'https://cdn.voiceflow.com/widget-next/bundle.mjs';
    v.type = 'text/javascript'; s.parentNode.insertBefore(v, s);
  })(document, 'script');
</script>
```

Logging still happens inside the same `bootstrap`/`finalize` Functions, so
widget conversations land in Supabase with `metadata.engine='voiceflow'`,
`metadata.path='widget'` — no extra plumbing. The widget path has no
`tenant_slug`/`channel` from an adapter, so `bootstrap` defaults
`tenant_slug='level_24_wines'`, `channel='web'` when the VF vars are absent.

## 5. Verification

Run `eval/runner/run_eval.py` (it drives both engines through the same
contract) then the 7 validity gates in `eval/README.md`. The VF build is
"parity-correct" when, for the same scenario, it produces grounded
in-catalogue recommendations, bare cart permalinks, silent capture, and the
no-solicitation / no-stall SQL gates return 0 for `eval-vf-*` contacts —
exactly as for `eval-n8n-*`.
