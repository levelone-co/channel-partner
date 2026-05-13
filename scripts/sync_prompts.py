"""
Sync prompts/*.md → Supabase `prompts` table.

Triggered by .github/workflows/sync-prompts.yml on push to main.
Can also be run locally:  python scripts/sync_prompts.py

Filename convention:
  prompts/<name>.md
    Cross-tenant. Synced to every row in `tenants` with `prompts.name = '<name>'`.

  prompts/<name>-<tenant_slug>.md
    Tenant-specific. Synced ONLY to the matching tenant with the trailing
    `-<tenant_slug>` stripped, so `prompts.name = '<name>'`.

A file is treated as tenant-specific only when its filename ends with
`-<slug>` for a slug that exists in the `tenants` table at sync time.
Otherwise it's cross-tenant.

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_SHA (or 'local' fallback)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from supabase import Client, create_client


def env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        sys.exit(f"Missing required env var: {key}")
    return val


def route(stem: str, tenants: list[dict]) -> tuple[str, list[dict]]:
    """
    Return (prompt_name, target_tenants).
    Tenant-specific if stem ends with `-<slug>` for a known tenant.
    """
    for t in tenants:
        suffix = f"-{t['slug']}"
        if stem.endswith(suffix):
            return stem[: -len(suffix)], [t]
    return stem, tenants


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    prompts_dir = repo_root / "prompts"
    if not prompts_dir.is_dir():
        sys.exit(f"No prompts/ directory at {prompts_dir}")

    sb: Client = create_client(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"))
    version = os.environ.get("GITHUB_SHA", "local")[:12]

    tenants = sb.table("tenants").select("id, slug").execute().data or []
    if not tenants:
        sys.exit("No tenants found. Run sql/0001_initial_schema.sql first.")

    md_files = sorted(prompts_dir.glob("*.md"))
    if not md_files:
        print("No prompt files found; nothing to sync.")
        return

    rows: list[dict] = []
    summary: list[tuple[str, str, int]] = []  # (filename, prompts.name, tenant_count)
    for md in md_files:
        content = md.read_text(encoding="utf-8")
        prompt_name, targets = route(md.stem, tenants)
        for t in targets:
            rows.append(
                {
                    "tenant_id": t["id"],
                    "name": prompt_name,
                    "content": content,
                    "version": version,
                }
            )
        summary.append((md.name, prompt_name, len(targets)))

    sb.table("prompts").upsert(rows, on_conflict="tenant_id,name").execute()
    print(f"Synced {len(md_files)} files → {len(rows)} prompt rows.")
    for filename, name, n in summary:
        scope = f"{n} tenants" if n > 1 else "1 tenant"
        print(f"  - {filename:50s} → name='{name}' ({scope})")


if __name__ == "__main__":
    main()
