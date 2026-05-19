"""Eval targets + Supabase ground-truth reader.

Both engines expose the SAME contract: an n8n webhook taking
  {tenant_slug, contact_id, channel, message}
and returning JSON containing a reply string. The VF path hits the
`vf-adapter` workflow which proxies to the Voiceflow Dialog API, so the
runner code is identical for both — only base URL + contact_id namespace
differ. That is what keeps the comparison apples-to-apples.

Env (see .env / .env.example):
  N8N_CORE_WEBHOOK_URL   e.g. https://<n8n>/webhook/ai-conversation-core
  VF_ADAPTER_WEBHOOK_URL e.g. https://<n8n>/webhook/vf-adapter
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field

import requests

TIMEOUT = 60


@dataclass
class TurnResult:
    reply: str
    latency_ms: int
    http_status: int
    raw: dict = field(default_factory=dict)
    error: str | None = None


@dataclass
class Target:
    """One engine under test."""

    name: str            # "n8n" | "vf"
    base_url: str        # full webhook URL
    ns_prefix: str       # contact_id namespace, e.g. "eval-n8n-"

    def contact_id(self, scenario_id: str, repeat: int) -> str:
        # Stable within a (scenario, repeat) run so multi-turn memory works;
        # unique across repeats so runs don't poison each other's history.
        return f"{self.ns_prefix}{scenario_id}-r{repeat}-{uuid.uuid4().hex[:6]}"

    def send(self, tenant_slug: str, contact_id: str, channel: str,
             message: str) -> TurnResult:
        payload = {
            "tenant_slug": tenant_slug,
            "contact_id": contact_id,
            "channel": channel,
            "message": message,
        }
        t0 = time.perf_counter()
        try:
            r = requests.post(self.base_url, json=payload, timeout=TIMEOUT)
            dt = int((time.perf_counter() - t0) * 1000)
            body = {}
            try:
                body = r.json()
            except Exception:
                body = {"raw_text": r.text}
            reply = (
                body.get("reply")
                or body.get("reply_text")
                or (body.get("metadata") or {}).get("reply")
                or body.get("raw_text")
                or ""
            )
            return TurnResult(reply=reply, latency_ms=dt,
                              http_status=r.status_code, raw=body)
        except Exception as e:  # network/timeout — record, don't crash run
            dt = int((time.perf_counter() - t0) * 1000)
            return TurnResult(reply="", latency_ms=dt, http_status=0,
                              raw={}, error=repr(e))


def targets_from_env() -> list[Target]:
    n8n_url = os.environ["N8N_CORE_WEBHOOK_URL"]
    vf_url = os.environ["VF_ADAPTER_WEBHOOK_URL"]
    return [
        Target("n8n", n8n_url, "eval-n8n-"),
        Target("vf", vf_url, "eval-vf-"),
    ]


# ---- Supabase ground-truth (post-run cost / row-count / SQL gates) --------

def _sb():
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    return url, h


def catalogue_titles(tenant_slug: str) -> list[str]:
    """Wine titles for the grounded_wine check."""
    url, h = _sb()
    tid = requests.get(
        f"{url}/rest/v1/tenants?slug=eq.{tenant_slug}&select=id",
        headers={**h, "Accept": "application/vnd.pgrst.object+json"},
        timeout=TIMEOUT,
    ).json()["id"]
    rows = requests.get(
        f"{url}/rest/v1/wines?tenant_id=eq.{tid}&select=title",
        headers=h, timeout=TIMEOUT,
    ).json()
    return [r["title"] for r in rows if r.get("title")]


def conversation_rows(contact_prefix: str) -> list[dict]:
    """All conversation rows whose contact_id starts with the eval prefix.
    PostgREST `like` with * wildcard."""
    url, h = _sb()
    rows = requests.get(
        f"{url}/rest/v1/conversations"
        f"?contact_id=like.{contact_prefix}*"
        f"&select=contact_id,role,content,channel,metadata,created_at"
        f"&order=created_at.asc",
        headers=h, timeout=TIMEOUT,
    )
    return rows.json() if rows.ok else []
