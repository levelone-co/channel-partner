# Channel Partner — Project Context

## What this is
Phase 0 of an agentic AI communication platform for wine estates.
GHL handles business operations. n8n + Claude API handles AI conversation.
Supabase is the portable data layer (stays through Phase 1 migration).

## Repository
github.com/levelone-co/channel-partner

## Phase 0 stack
- GHL: CRM, unified inbox, channels, automations
- n8n Cloud: webhook endpoint + AI orchestration
- Supabase: PostgreSQL + pgvector (conversations, contacts, RAG)
- Claude API: LLM (claude-sonnet-4-5 or claude-haiku-4-5)
- Shopify Storefront API: cart operations

## Build order (Phase 0)
1. n8n webhook → Claude API connection (test this first)
2. RAG pipeline: embed wine catalogue into Supabase pgvector
3. GHL → n8n webhook routing (all channels → AI layer)
4. Shopify tool use (add to cart, check stock)
5. Age-gate flow in GHL

## Migration rules (keep Phase 1 easy)
- All prompts as Markdown files in /prompts directory
- All tool definitions as JSON in /tools directory
- Conversation history stored in Supabase, not GHL
- Shopify API logic in n8n, not GHL workflows

## Key files
- /prompts/10-behavioural-training-sale.md — sales methodology, tone, channel matching (cross-tenant platform IP)
- /prompts/20-domain-knowledge-wine.md — wine vocabulary, pairings, SA context (cross-tenant within wine vertical)
- /prompts/30-profile-account-{tenant}.md — account persona + open facts
- /prompts/40-playbook-account-{tenant}.md — account proprietary positioning
- /tools/shopify-tools.json — tool definitions for cart operations (used in Step 4)
- /workflows/ai-conversation-core.json — n8n workflow (webhook → RAG → Claude → log)
- /sql/000{1,2,3}_*.sql — Supabase schema + RPCs
- /scripts/ingest_wines.py — Shopify → Voyage → Supabase ingestion

## Phase 0 experiments
Parallel evaluations to run alongside the n8n + Claude path before committing for the pilot:
- **Voiceflow vs n8n + Claude API** — build the same Sarah-for-Level-24 in Voiceflow (designed in their studio, with the same Supabase pgvector RAG). Compare on: response quality, end-to-end latency, prompt-editing ergonomics for the operator, monthly cost at expected volume, lock-in risk (how easy to migrate prompts/state out). Pick the winner for the pilot launch; the migration rules above keep either choice portable to Phase 1.

## Phase 1 backlog (deferred from Phase 0)
Latency + routing improvements that aren't worth doing while the core architecture is still settling:
- **Intent classifier upstream** — tiny first Claude call (haiku, ~50 tokens) routes "product question" → full RAG, "FAQ" → templated answer, "greeting" → canned reply. Adds ~500ms to slow path, saves 3–4s on fast path.
- **Streaming responses for web chat** — customer sees tokens within ~600ms instead of waiting for full completion. Doesn't apply to SMS/WhatsApp (need full message).
- **Smaller models for short utterances** — even Haiku 4.5 is overkill for "yes please" / "what time do you close?". Route short or stereotyped utterances to a cheaper path.
- **Parallelise Supabase + Voyage fetches** — attempted in Phase 0 by fanning Get Tenant out to Get Prompt + Get History + Voyage Embed, but n8n fires Build Messages on the first arriving input rather than waiting for all three. Proper fix: add a Merge node (typeVersion 3.x, mode "combine" with 3 inputs) before Build Messages as a sync barrier. ~400ms saving.
- **GHL All-in-One widget + Voice AI for follow-up** — Phase 0 uses the focused GHL *Live chat* widget (clean, no Meta gates). Later, the *All-in-One* widget (WhatsApp + live chat + email/SMS + FB/IG + Voice AI in one) is of interest — especially **Voice AI for follow-up** flows (outbound voice nudges, post-purchase check-ins). Revisit once WhatsApp display-name approval clears and the reactive flow is solid. Voice follow-up pairs naturally with the return-channel capture work.
- **Live cart icon / true in-page cart needs a custom front-end widget** — Phase 0 carts are zero-auth Shopify permalinks (server-built; the customer opens the link to load the cart). The storefront cart icon CANNOT update in real time from any server-side method (permalink, Storefront API, Admin draft orders) — that requires JS in the visitor's session calling Shopify's /cart/*.js AJAX endpoints, which the closed GHL iframe widget can't do. Live icon + true add/remove in the on-page cart is a Phase-1 deliverable tied to the custom page-aware widget. Sarah has full control of the *prepared link* contents via add_to_cart/set_cart in the meantime.
- **Proactive WhatsApp requires approved templates** — WhatsApp Business only allows free-form ("session") messages within 24h of the customer's last inbound. The reactive Sarah flow is unaffected (customer just messaged → window open). But proactive outreach — the "your vintage just dropped" / "back in stock" follow-ups that make return-channel capture commercially valuable — needs pre-approved WhatsApp Message Templates (HSM) submitted through the WhatsApp Business account. Template approval takes 1–2 days each and templates can't contain arbitrary AI-generated copy (only named variables). Phase 1 nurture design must account for this: either templated nudges that pull the customer back into a session, or fall back to email/SMS for proactive sends.
