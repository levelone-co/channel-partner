"""
Knowledge-base ingestion: knowledge_base/<tenant_slug>/*.md → Voyage embeddings → Supabase.

Usage:
    python scripts/ingest_knowledge.py --tenant level_24_wines

Filename convention:
  knowledge_base/<tenant_slug>/<source_name>.md
    Each file is one row (one source). The script chunks the file naively: one
    embedding per file. For longer-form docs we'd add paragraph-level chunking,
    but Phase 0 docs are short enough that whole-file embedding is fine.

Env vars (loaded from .env at repo root):
    VOYAGE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
    DEFAULT_TENANT_SLUG (fallback if --tenant omitted)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

VOYAGE_MODEL = "voyage-4-lite"
VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings"
EXPECTED_EMBED_DIM = 512


def env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        sys.exit(f"Missing required env var: {key}")
    return val


def embed_batch(api_key: str, inputs: list[str]) -> list[list[float]]:
    if not inputs:
        return []
    r = requests.post(
        VOYAGE_EMBED_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": VOYAGE_MODEL,
            "input": inputs,
            "input_type": "document",
            "output_dimension": EXPECTED_EMBED_DIM,
        },
        timeout=60,
    )
    r.raise_for_status()
    data = sorted(r.json().get("data", []), key=lambda d: d["index"])
    vectors = [d["embedding"] for d in data]
    for v in vectors:
        if len(v) != EXPECTED_EMBED_DIM:
            sys.exit(
                f"Voyage returned embedding of dim {len(v)}, expected "
                f"{EXPECTED_EMBED_DIM}. Update sql vector(N) and retry."
            )
    return vectors


def get_tenant_id(sb: Client, slug: str) -> str:
    res = sb.table("tenants").select("id").eq("slug", slug).single().execute()
    if not res.data:
        sys.exit(f"Tenant '{slug}' not found. Run sql/0001_initial_schema.sql first.")
    return res.data["id"]


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    load_dotenv(repo_root / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tenant",
        default=os.environ.get("DEFAULT_TENANT_SLUG", "level_24_wines"),
    )
    args = parser.parse_args()

    voyage_key = env("VOYAGE_API_KEY")
    sb = create_client(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))

    tenant_id = get_tenant_id(sb, args.tenant)
    print(f"Tenant: {args.tenant} ({tenant_id})")

    kb_dir = repo_root / "knowledge_base" / args.tenant
    if not kb_dir.is_dir():
        sys.exit(f"No knowledge base directory at {kb_dir}")

    md_files = sorted(f for f in kb_dir.glob("*.md") if f.name.lower() != "readme.md")
    if not md_files:
        print("No .md files found (README.md is excluded); nothing to ingest.")
        return

    rows: list[dict[str, Any]] = []
    texts: list[str] = []
    for f in md_files:
        content = f.read_text(encoding="utf-8").strip()
        if not content:
            continue
        rows.append(
            {
                "tenant_id": tenant_id,
                "source": f.name,
                "content": content,
                "metadata": {"path": str(f.relative_to(repo_root))},
            }
        )
        texts.append(content)

    print(f"Embedding {len(texts)} knowledge-base docs via {VOYAGE_MODEL}...")
    embeddings = embed_batch(voyage_key, texts)
    for r, e in zip(rows, embeddings):
        r["embedding"] = e

    # Clear-and-replace for this tenant to keep things simple and idempotent.
    # If you have many docs and want incremental updates, switch to per-row upsert
    # keyed by (tenant_id, source).
    sb.table("knowledge_base").delete().eq("tenant_id", tenant_id).execute()
    sb.table("knowledge_base").insert(rows).execute()

    print(f"Inserted {len(rows)} knowledge-base rows.")
    for r in rows:
        print(f"  - {r['source']:50s} chars={len(r['content']):>5}  dim={len(r['embedding'])}")


if __name__ == "__main__":
    main()
