# Sarah eval — Voiceflow vs n8n+Claude

Formal, repeatable comparison to pick the pilot orchestration engine.
Branch: `eval/voiceflow`. Both engines share the SAME Supabase data layer,
prompts, tools and RAG (migration rules) — the eval isolates the
orchestration engine as the only variable.

> **⚠ Cross-modality (operator decision):** the VF project is built as a
> **Voice** assistant; n8n is **text**. This is NOT a clean apples-to-apples
> head-to-head. The text harness below is retained only as a
> **functional-parity probe** of the VF voice project (grounding, tool use,
> SQL gates) — VF latency from it is NOT comparable and is excluded from
> latency scoring. Voice quality / perceived latency / voice-readiness are
> scored from the **live published voice widget**. See the cross-modality
> notice in `rubric/quality-rubric.yaml`. The final output is a
> recommendation with explicit modality caveats, not a pure weighted-sum
> winner.

## Layout

```
eval/
  scenarios/sarah-scenarios.yaml   12 scenarios, ordered turns + expects
  rubric/quality-rubric.yaml       5 weighted dimensions, anchors, gate
  runner/run_eval.py               driver (drives BOTH engines)
  runner/targets.py                n8n + VF adapters + Supabase reader
  runner/cost_model.py             3 volume bands, 2×3 cost table
  results/<ts>-{raw,blind,key,report}   per-run artifacts
```

## Prereqs

1. n8n core workflow live (`workflows/ai-conversation-core.json`) — the
   **n8n eval target, unchanged**.
2. Voiceflow agent built per `voiceflow/README.md`, and
   `workflows/vf-adapter.json` imported (set n8n Variable `VF_DM_API_KEY`,
   re-select GHL credential if prompted).
3. `.env` at repo root with `N8N_CORE_WEBHOOK_URL`,
   `VF_ADAPTER_WEBHOOK_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Run

```bash
cd eval/runner
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run_eval.py --only pairing-steak --repeats 1   # dry-run, both engines
python run_eval.py                                     # full run (N=5)
```

Then score `results/<ts>-blind.jsonl` against `rubric/quality-rubric.yaml`
(engine label is hidden — use `<ts>-key.json` to de-blind only AFTER
scoring), fill the manual dimensions in `results/<ts>-report.md`, and run
the validity gates below.

## Eval-validity gates — the eval is valid only if ALL pass

Run in the Supabase SQL editor. `evidence` should be 0 / as stated for
**both** the `eval-n8n-` and `eval-vf-` contact namespaces.

**Gate 1 — grounded recommendations (both engines).** Spot-check
`results/<ts>-raw.jsonl`: `grounded_wine` checks pass on `pairing-steak`,
`browse-then-narrow`, `multi-turn-memory` for n8n AND vf.

**Gate 2 — no-solicitation discipline (SETUP §7.6.5):**
```sql
select count(*) from conversations
where role='assistant'
  and (contact_id like 'eval-vf-%' or contact_id like 'eval-n8n-%')
  and content ~* '(what is your|can i have your|what.s your|please share your) (phone|email|number|whatsapp|contact)';
-- expect 0
```

**Gate 3 — no-stall discipline (SETUP §8.6.4), consult_team runs:**
```sql
select count(*) from conversations
where role='assistant'
  and (contact_id like 'eval-vf-%' or contact_id like 'eval-n8n-%')
  and content ~* '(let me get back to|give me a moment|i.ll find out|hold on while|i.ll confirm)';
-- expect 0
```

**Gate 4 — latency stability.** In `<ts>-report.md`, p90/median per engine
within ±25% across the N≥5 repeats (re-run if a cold start skewed it).

**Gate 5 — row-count parity.** Each engine wrote a user + assistant row per
turn, tagged with the engine:
```sql
select metadata->>'engine' as engine, role, count(*)
from conversations
where contact_id like 'eval-%'
group by 1,2 order by 1,2;
-- vf rows must carry metadata.engine='voiceflow'; counts comparable per role
```

**Gate 6 — channel layer identical.** `workflows/vf-adapter.json` `Extract`
node's channel map is byte-identical to `ai-conversation-core.json`
`Extract` (the `{SMS:'sms',Email:'email',WhatsApp:'whatsapp',Live_Chat:'web',FB:'whatsapp',IG:'whatsapp'}`
expression). Diff-check on import.

**Gate 7 — cart-claim discipline.** For `add-to-cart-flow`,
`cart-clear-discipline`, `cart-replace`: every reply that asserts a cart
change has a corresponding `customer_carts` row mutation in the same turn
(check `customer_carts.updated_at` against the turn timestamp), and the
checkout URL is a bare `https://…/cart/…` (the `bare_url` check), for both
engines.

## Decision

`results/<ts>-report.md` carries the weighted matrix. Response-quality is a
hard gate (blind mean < 3.5/5 ⇒ disqualified). Winner = highest blended
score at the most-likely volume band. Voice is scored only as the Phase-1
readiness sub-criterion under "Lock-in & capability" (provider TBD — see the
plan); it is deliberately not a live tested channel here.
