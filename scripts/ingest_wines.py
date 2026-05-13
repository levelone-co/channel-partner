"""
Wine catalogue ingestion: Shopify Admin → Voyage embeddings → Supabase.

Usage:
    python scripts/ingest_wines.py --tenant level_24_wines

Env vars (loaded from .env at repo root):
    SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN,
    VOYAGE_API_KEY,
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
    DEFAULT_TENANT_SLUG (fallback if --tenant omitted)

Idempotent: re-run any time Shopify products change.
"""

from __future__ import annotations

import argparse
import html
import os
import re
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

SHOPIFY_API_VERSION = "2024-10"
VOYAGE_MODEL = "voyage-3-lite"
VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings"
EXPECTED_EMBED_DIM = 512  # voyage-3-lite is fixed at 512


def env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        sys.exit(f"Missing required env var: {key}")
    return val


def strip_html(s: str | None) -> str:
    if not s:
        return ""
    no_tags = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(no_tags)).strip()


def fetch_shopify_products(domain: str, token: str) -> list[dict[str, Any]]:
    """Fetch all products via Shopify Admin REST. Paginates via the Link header."""
    url = f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/products.json?limit=250"
    headers = {"X-Shopify-Access-Token": token, "Content-Type": "application/json"}
    products: list[dict[str, Any]] = []
    while url:
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        products.extend(r.json().get("products", []))
        url = _next_link(r.headers.get("Link", ""))
    return products


def _next_link(link_header: str) -> str | None:
    # Shopify pagination: `<https://...&page_info=xyz>; rel="next"`
    for part in link_header.split(","):
        m = re.match(r'\s*<([^>]+)>\s*;\s*rel="next"', part)
        if m:
            return m.group(1)
    return None


def fetch_product_metafields(domain: str, token: str, product_id: int) -> dict[str, str]:
    """Pull all metafields for a product, flattened to {namespace.key: value}."""
    url = (
        f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}"
        f"/products/{product_id}/metafields.json"
    )
    headers = {"X-Shopify-Access-Token": token, "Content-Type": "application/json"}
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    out: dict[str, str] = {}
    for mf in r.json().get("metafields", []):
        key = f'{mf.get("namespace","")}.{mf.get("key","")}'.strip(".")
        out[key] = str(mf.get("value", ""))
    return out


def extract_wine_fields(product: dict[str, Any], metafields: dict[str, str]) -> dict[str, Any]:
    """
    Map a Shopify product + its metafields to the columns of the `wines` table.

    Convention used:
      - Top-level: title, handle, id, body_html, variants[0].price
      - Metafields (namespace.key): `custom.varietal`, `custom.vintage`,
        `custom.pairings`, `custom.awards`. Fall back to `wine.*` namespace
        if `custom.*` is empty.
    """
    variants = product.get("variants") or [{}]
    price = variants[0].get("price")

    def mf(*candidates: str) -> str:
        for c in candidates:
            v = metafields.get(c)
            if v:
                return v
        return ""

    inventory_total = sum(int(v.get("inventory_quantity") or 0) for v in variants)
    return {
        "shopify_product_id": str(product["id"]),
        "handle": product.get("handle"),
        "title": product["title"],
        "varietal": mf("custom.varietal", "wine.varietal"),
        "vintage": mf("custom.vintage", "wine.vintage"),
        "price": float(price) if price else None,
        "description": strip_html(product.get("body_html")),
        "pairings": mf("custom.pairings", "wine.pairings"),
        "awards": mf("custom.awards", "wine.awards"),
        "inventory_available": inventory_total > 0,
    }


def canonical_text(w: dict[str, Any]) -> str:
    parts = [w["title"]]
    if w.get("varietal") or w.get("vintage"):
        parts.append(f"{w.get('varietal','')} {w.get('vintage','')}".strip())
    if w.get("price"):
        parts.append(f"R{w['price']:.2f}")
    if w.get("description"):
        parts.append(w["description"])
    if w.get("pairings"):
        parts.append(f"Pairings: {w['pairings']}")
    if w.get("awards"):
        parts.append(f"Awards: {w['awards']}")
    return ". ".join(p for p in parts if p)


def embed_batch(api_key: str, inputs: list[str]) -> list[list[float]]:
    if not inputs:
        return []
    r = requests.post(
        VOYAGE_EMBED_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={"model": VOYAGE_MODEL, "input": inputs, "input_type": "document"},
        timeout=60,
    )
    r.raise_for_status()
    data = r.json().get("data", [])
    data.sort(key=lambda d: d["index"])
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
        sys.exit(
            f"Tenant '{slug}' not found. Run sql/0001_initial_schema.sql first."
        )
    return res.data["id"]


def upsert_wines(sb: Client, tenant_id: str, rows: list[dict[str, Any]]) -> None:
    for r in rows:
        r["tenant_id"] = tenant_id
    sb.table("wines").upsert(
        rows, on_conflict="tenant_id,shopify_product_id"
    ).execute()


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    load_dotenv(repo_root / ".env")

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tenant",
        default=os.environ.get("DEFAULT_TENANT_SLUG", "level_24_wines"),
        help="Tenant slug (default: $DEFAULT_TENANT_SLUG or 'level_24_wines')",
    )
    args = parser.parse_args()

    shopify_domain = env("SHOPIFY_STORE_DOMAIN")
    shopify_token = env("SHOPIFY_ADMIN_TOKEN")
    voyage_key = env("VOYAGE_API_KEY")
    sb = create_client(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))

    tenant_id = get_tenant_id(sb, args.tenant)
    print(f"Tenant: {args.tenant} ({tenant_id})")

    products = fetch_shopify_products(shopify_domain, shopify_token)
    print(f"Fetched {len(products)} products from Shopify")
    if not products:
        return

    rows: list[dict[str, Any]] = []
    for p in products:
        mfs = fetch_product_metafields(shopify_domain, shopify_token, p["id"])
        rows.append(extract_wine_fields(p, mfs))

    texts = [canonical_text(r) for r in rows]
    print(f"Embedding {len(texts)} wines via {VOYAGE_MODEL}...")
    embeddings = embed_batch(voyage_key, texts)
    for r, e in zip(rows, embeddings):
        r["embedding"] = e

    upsert_wines(sb, tenant_id, rows)
    print(f"Upserted {len(rows)} wines.")
    for r in rows:
        print(f"  - {r['title']!r:50s} dim={len(r['embedding'])}")


if __name__ == "__main__":
    main()
