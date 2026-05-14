# Level 24 — Internal Knowledge Base

Each `.md` file in this directory becomes one row in Supabase's `knowledge_base` table after running:

```bash
python scripts/ingest_knowledge.py --tenant level_24_wines
```

Sarah can query this content via her `consult_knowledge_base` tool when a customer asks something specific to this estate that isn't covered by the wine catalogue or the cross-tenant prompts (history, hours, shipping policy, returns, supplier info, etc.).

## Conventions

- One topic per file. Filenames describe the topic (e.g. `visiting-and-shipping.md`, `winemaker-bio.md`).
- Plain Markdown. Headings are fine; the ingestion script embeds the whole file as one row, so keep files focused.
- Write for a sommelier audience — concrete facts, no marketing fluff. Sarah will rephrase appropriately for the customer.
- Re-run `scripts/ingest_knowledge.py` after every change. The script clears + replaces all rows for the tenant; no diff tracking.

## Source-of-truth principle

The estate's wine catalogue lives in Shopify (ingested separately). The estate's persona + sales playbook lives in `prompts/30-profile-account-level_24_wines.md` and `prompts/40-playbook-account-level_24_wines.md`. **This directory is for everything else** — the kind of question a knowledgeable employee would answer from memory but that isn't structured product data or behavioural rules.
