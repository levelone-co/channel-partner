#!/usr/bin/env python3
"""Sarah eval driver — runs the scenario set against BOTH engines.

Usage:
    cd eval/runner
    pip install -r requirements.txt
    # env: N8N_CORE_WEBHOOK_URL, VF_ADAPTER_WEBHOOK_URL,
    #      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (load from repo .env)
    python run_eval.py --scenarios ../scenarios/sarah-scenarios.yaml
    python run_eval.py --only pairing-steak --repeats 1   # quick dry-run

Outputs (eval/results/<ts>-*):
  raw.jsonl    full per-turn capture incl. engine label
  blind.jsonl  engine label stripped + shuffled (for blind quality scoring)
  key.json     blind_id -> engine map (de-blind AFTER scoring)
  report.md    latency + cost + pass-matrix + decision-matrix template
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
import cost_model  # noqa: E402
from targets import targets_from_env, catalogue_titles  # noqa: E402

RESULTS = Path(__file__).resolve().parents[1] / "results"


# ---- expect-check evaluation --------------------------------------------

def _markdown_wrapped_url(text: str) -> bool:
    """True if a /cart/ url is wrapped in markdown/backticks/bold."""
    return bool(
        re.search(r"\[[^\]]*\]\(https?://[^)]*?/cart/", text)
        or re.search(r"[*`]+\s*https?://[^ ]*?/cart/", text)
        or re.search(r"https?://[^ ]*?/cart/[^ ]*[*`]+", text)
    )


def check_turn(reply: str, checks: list, catalogue: list[str]) -> list[dict]:
    out = []
    low = reply.lower()
    for chk in checks:
        if chk == "grounded_wine":
            ok = any(t.lower() in low for t in catalogue)
            out.append({"check": "grounded_wine", "ok": ok})
        elif chk == "bare_url":
            has_cart = "/cart/" in low
            ok = has_cart and not _markdown_wrapped_url(reply)
            out.append({"check": "bare_url", "ok": ok})
        elif isinstance(chk, dict):
            (kind, val), = chk.items()
            if kind == "contains":
                ok = val.lower() in low
            elif kind == "not_contains":
                ok = val.lower() not in low
            elif kind == "regex":
                ok = bool(re.search(val, reply, re.I))
            elif kind == "not_regex":
                ok = not re.search(val, reply, re.I)
            else:
                ok = False
                kind = f"unknown:{kind}"
            out.append({"check": f"{kind}:{val}", "ok": ok})
        else:
            out.append({"check": f"malformed:{chk}", "ok": False})
    return out


# ---- run -----------------------------------------------------------------

def run(scenarios_path: Path, only: str | None, repeats_override: int | None):
    spec = yaml.safe_load(scenarios_path.read_text())
    meta = spec.get("meta", {})
    tenant = meta.get("tenant_slug", "level_24_wines")
    repeats = repeats_override or meta.get("repeats", 5)
    scenarios = spec["scenarios"]
    if only:
        scenarios = [s for s in scenarios if s["id"] == only]
        if not scenarios:
            sys.exit(f"no scenario id={only}")

    targets = targets_from_env()
    catalogue = catalogue_titles(tenant)
    print(f"catalogue: {len(catalogue)} wines | targets: "
          f"{[t.name for t in targets]} | repeats={repeats}")

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    RESULTS.mkdir(exist_ok=True)
    raw_f = RESULTS / f"{ts}-raw.jsonl"
    blind_rows, key_map = [], {}
    lat = {t.name: [] for t in targets}        # all turn latencies
    passes = {}                                # (scenario, engine) -> ratio

    with raw_f.open("w") as rf:
        for sc in scenarios:
            sid, ch = sc["id"], sc.get("channel", "web")
            for tgt in targets:
                turn_pass, turn_total = 0, 0
                for rp in range(repeats):
                    cid = tgt.contact_id(sid, rp)
                    for ti, turn in enumerate(sc["turns"]):
                        res = tgt.send(tenant, cid, ch, turn["user"])
                        lat[tgt.name].append(res.latency_ms)
                        checks = check_turn(
                            res.reply, turn.get("expect", []), catalogue)
                        turn_total += len(checks)
                        turn_pass += sum(1 for c in checks if c["ok"])
                        rec = {
                            "ts": ts, "scenario": sid, "engine": tgt.name,
                            "repeat": rp, "turn": ti, "channel": ch,
                            "contact_id": cid, "user": turn["user"],
                            "reply": res.reply, "latency_ms": res.latency_ms,
                            "http_status": res.http_status,
                            "error": res.error, "checks": checks,
                        }
                        rf.write(json.dumps(rec) + "\n")
                        bid = f"b{len(blind_rows):04d}"
                        key_map[bid] = tgt.name
                        blind_rows.append({
                            "blind_id": bid, "scenario": sid, "turn": ti,
                            "user": turn["user"], "reply": res.reply,
                        })
                        print(f"  {sid:24s} {tgt.name:3s} r{rp} t{ti} "
                              f"{res.latency_ms:5d}ms "
                              f"{sum(c['ok'] for c in checks)}/{len(checks)}"
                              + (f" ERR {res.error}" if res.error else ""))
                        time.sleep(0.3)   # gentle on the webhooks
                passes[(sid, tgt.name)] = (
                    turn_pass / turn_total if turn_total else 0.0)

    random.shuffle(blind_rows)
    (RESULTS / f"{ts}-blind.jsonl").write_text(
        "\n".join(json.dumps(r) for r in blind_rows))
    (RESULTS / f"{ts}-key.json").write_text(json.dumps(key_map, indent=2))

    report = render_report(ts, scenarios, targets, passes, lat)
    (RESULTS / f"{ts}-report.md").write_text(report)
    print(f"\nwrote: {raw_f.name}, {ts}-blind.jsonl, {ts}-key.json, "
          f"{ts}-report.md")
    print("\nNEXT: score blind.jsonl against rubric, then run the 7 "
          "validity-gate SQL queries in eval/README.md.")


def _latency_score(p50: float) -> int:
    for s, cap in [(5, 3000), (4, 4500), (3, 6500), (2, 9000)]:
        if p50 <= cap:
            return s
    return 1


def render_report(ts, scenarios, targets, passes, lat) -> str:
    L = [f"# Sarah eval report — {ts}", ""]
    L += ["## Automated check pass-rate (objective signals only)",
          "", "| Scenario | " + " | ".join(t.name for t in targets) + " |",
          "|---|" + "---|" * len(targets)]
    for sc in scenarios:
        row = f"| {sc['id']} | "
        row += " | ".join(
            f"{passes.get((sc['id'], t.name), 0)*100:.0f}%" for t in targets)
        L.append(row + " |")

    L += ["", "## Latency (ms, all turns across repeats)", "",
          "| Engine | n | p50 | p90 | auto-score |",
          "|---|---|---|---|---|"]
    for t in targets:
        v = sorted(lat[t.name])
        if not v:
            L.append(f"| {t.name} | 0 | - | - | - |")
            continue
        p50 = statistics.median(v)
        p90 = v[min(len(v) - 1, int(len(v) * 0.9))]
        L.append(f"| {t.name} | {len(v)} | {p50:.0f} | {p90:.0f} "
                 f"| {_latency_score(p50)}/5 |")

    L += ["", "## Monthly cost at volume", "", cost_model.table(),
          "", "## Decision matrix (fill manual dims, then compute)", "",
          "| Dimension | Weight | n8n | vf |",
          "|---|---|---|---|",
          "| Response quality (BLIND — gate <3.5) | 0.35 | _ | _ |",
          "| End-to-end latency (auto above) | 0.20 | _ | _ |",
          "| Prompt-editing ergonomics | 0.15 | _ | _ |",
          "| Monthly cost @ volume | 0.20 | _ | _ |",
          "| Lock-in & capability (incl. voice readiness) | 0.10 | _ | _ |",
          "| **Blended** | **1.00** | **_** | **_** |", "",
          "Quality is a hard gate: any engine with mean blind quality "
          "< 3.5/5 is disqualified regardless of cost. Winner = highest "
          "blended score at the most-likely volume band.", ""]
    return "\n".join(L)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios", default=str(
        Path(__file__).resolve().parents[1]
        / "scenarios" / "sarah-scenarios.yaml"))
    ap.add_argument("--only", help="run a single scenario id")
    ap.add_argument("--repeats", type=int, help="override meta.repeats")
    a = ap.parse_args()
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    run(Path(a.scenarios), a.only, a.repeats)
