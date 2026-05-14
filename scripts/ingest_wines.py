"""
Wine catalogue ingestion: Shopify Admin → Voyage embeddings → Supabase.

Usage:
    python scripts/ingest_wines.py --tenant level_24_wines

Env vars (loaded from .env at repo root):
    SHOPIFY_STORE_DOMAIN

    # Shopify auth — either supply a static admin token directly...
    SHOPIFY_ADMIN_TOKEN

    # ...or supply client credentials and we'll mint one on the fly
    # (https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets):
    SHOPIFY_CLIENT_ID
    SHOPIFY_CLIENT_SECRET

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
VOYAGE_MODEL = "voyage-4-lite"
VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings"
EXPECTED_EMBED_DIM = 512  # voyage-4-lite supports output_dimension 256/512/1024/2048; we request 512 to match the pgvector(512) column


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


def resolve_shopify_admin_token(domain: str) -> str:
    """Return a valid Admin API access token.

    Preference order:
      1. SHOPIFY_ADMIN_TOKEN if set — used as-is.
      2. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET — minted via the
         client_credentials grant.
    """
    static = os.environ.get("SHOPIFY_ADMIN_TOKEN")
    if static:
        return static

    client_id = os.environ.get("SHOPIFY_CLIENT_ID")
    client_secret = os.environ.get("SHOPIFY_CLIENT_SECRET")
    if not (client_id and client_secret):
        sys.exit(
            "Need either SHOPIFY_ADMIN_TOKEN, or both SHOPIFY_CLIENT_ID and "
            "SHOPIFY_CLIENT_SECRET, in .env"
        )

    r = requests.post(
        f"https://{domain}/admin/oauth/access_token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=30,
    )
    if r.status_code != 200:
        sys.exit(
            f"Failed to mint Admin API token via client_credentials: "
            f"{r.status_code} {r.text[:200]}"
        )
    token = r.json().get("access_token")
    if not token:
        sys.exit(f"client_credentials response had no access_token: {r.text[:200]}")
    return token


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


VINTAGE_OPTION_NAMES = {"vintage", "year", "harvest", "harvest year"}


def find_vintage_option_position(product: dict[str, Any]) -> int | None:
    """Find which option (1/2/3) on the product holds the vintage, or None."""
    for opt in product.get("options", []) or []:
        if (opt.get("name") or "").strip().lower() in VINTAGE_OPTION_NAMES:
            return int(opt.get("position") or 1)
    return None


def variant_vintage(product: dict[str, Any], variant: dict[str, Any]) -> str:
    """Return the vintage string for a variant, falling back to product-level if needed."""
    pos = find_vintage_option_position(product)
    if pos:
        v = variant.get(f"option{pos}")
        if v:
            return str(v).strip()
    return ""


def extract_product_fields(product: dict[str, Any], metafields: dict[str, str]) -> dict[str, Any]:
    """Product-level fields shared by every variant of this product."""

    def mf(*candidates: str) -> str:
        for c in candidates:
            v = metafields.get(c)
            if v:
                return v
        return ""

    sweetness = mf("shopify.wine-sweetness")
    country = mf("shopify.country", "shopify.product-country")
    region = mf("shopify.region", "shopify.product-region")
    product_range = mf("custom.range", "custom.product-range", "wine.range")
    product_type = (product.get("product_type") or "").strip()
    tags = (product.get("tags") or "").strip()

    base_description = strip_html(product.get("body_html"))
    context_bits: list[str] = []
    if product_type:
        context_bits.append(f"Type: {product_type}.")
    if product_range:
        context_bits.append(f"Range: {product_range}.")
    if region or country:
        context_bits.append(f"From {', '.join(b for b in [region, country] if b)}.")
    if sweetness:
        context_bits.append(f"Sweetness: {sweetness}.")
    if tags:
        context_bits.append(f"Tags: {tags}.")
    product_description = (" ".join(context_bits) + " " + base_description).strip()

    # Product-level vintage fallback. Vintage is normally captured as a Shopify
    # Variant option; this fallback only fires if no such option exists.
    product_vintage = mf(
        "shopify.wine-vintage", "shopify.production-year", "shopify.vintage",
        "wine.vintage", "wine.year",
    )

    return {
        "shopify_product_id": str(product["id"]),
        "handle": product.get("handle"),
        "title": product["title"],
        "varietal": mf(
            "custom.varietal", "custom.variety",
            "shopify.wine-variety", "shopify.wine-varietal",
            "wine.variety", "wine.varietal",
        ),
        "description": product_description,
        "pairings": mf(
            "custom.pairings", "custom.food-pairings", "custom.food_pairings",
            "wine.pairings", "wine.food-pairings",
        ),
        "awards": mf(
            "custom.awards", "custom.ratings",
            "wine.awards", "wine.ratings",
        ),
        "_product_vintage_fallback": product_vintage,
    }


def make_variant_row(
    product: dict[str, Any],
    variant: dict[str, Any],
    product_fields: dict[str, Any],
) -> dict[str, Any]:
    """One row per Shopify variant. Vintage and price come from the variant."""
    vintage = variant_vintage(product, variant) or product_fields["_product_vintage_fallback"]
    inventory_qty = int(variant.get("inventory_quantity") or 0)

    row = {k: v for k, v in product_fields.items() if not k.startswith("_")}
    row["shopify_variant_id"] = str(variant["id"])
    row["vintage"] = vintage
    row["price"] = float(variant["price"]) if variant.get("price") else None
    row["inventory_available"] = inventory_qty > 0
    return row


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
        json={
            "model": VOYAGE_MODEL,
            "input": inputs,
            "input_type": "document",
            "output_dimension": EXPECTED_EMBED_DIM,
        },
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
        rows, on_conflict="tenant_id,shopify_variant_id"
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
    shopify_token = resolve_shopify_admin_token(shopify_domain)
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
        product_fields = extract_product_fields(p, mfs)
        for v in p.get("variants") or []:
            rows.append(make_variant_row(p, v, product_fields))

    if not rows:
        print("No variants found; nothing to embed.")
        return

    texts = [canonical_text(r) for r in rows]
    print(f"Embedding {len(rows)} variants via {VOYAGE_MODEL}...")
    embeddings = embed_batch(voyage_key, texts)
    for r, e in zip(rows, embeddings):
        r["embedding"] = e

    upsert_wines(sb, tenant_id, rows)
    print(f"Upserted {len(rows)} variant rows.")
    for r in rows:
        label = f"{r['title']} {r.get('vintage','')}".strip()
        print(f"  - {label!r:50s} R{r.get('price','?'):>7} dim={len(r['embedding'])}")


if __name__ == "__main__":
    main()
