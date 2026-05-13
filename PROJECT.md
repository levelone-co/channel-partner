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
- /prompts/system-prompt.md — main agent system prompt
- /prompts/behavioural-training.md — sales bias, tone, methodology
- /tools/shopify-tools.json — tool definitions for cart operations
