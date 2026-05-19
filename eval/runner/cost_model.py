"""Monthly-cost-at-volume model: n8n+Claude vs Voiceflow.

Shared per-conversation LLM cost (Claude Haiku + Voyage embed) is IDENTICAL
on both engines because both call the same Anthropic + Voyage endpoints with
the same prompts/tools — so it cancels out of the comparison and is excluded
here. Only the orchestration-platform differentiators are modelled.

All figures are EDITABLE published-pricing assumptions (Voiceflow free/
sandbox account => paid-tier numbers are projections, flagged as caveats).
Update the constants below with real quotes before the decision is final.
"""
from __future__ import annotations

VOLUME_BANDS = [500, 2000, 10000]   # conversations / month

# --- n8n Cloud: flat plan fee; pick the tier that covers the execution
#     volume. One conversation ~= 1 workflow execution (+ sub-workflows are
#     same-execution). Marginal per-conv cost ~= 0 within plan quota.
N8N = {
    "plan_by_band": {            # plan $/mo that comfortably covers the band
        500: 24,                 # Starter-ish
        2000: 24,
        10000: 60,               # Pro-ish (higher execution quota)
    },
    "per_conv_usd": 0.0,
}

# --- Voiceflow: plan fee + metered Dialog API / "AI tokens" / Function
#     invocations. Free/sandbox has a hard request quota; paid tiers meter
#     usage. Treat as platform_fee + per-conversation marginal.
VOICEFLOW = {
    "plan_by_band": {
        500: 0,                  # may fit free/sandbox quota (CAVEAT: verify)
        2000: 60,                # Pro-ish
        10000: 60,
    },
    # marginal: Dialog API interactions per conversation (~ multi-turn) +
    # Function invocations (8 tools * loop). Conservative placeholder.
    "per_conv_usd": 0.010,
}


def monthly_cost(engine: str, volume: int) -> float:
    cfg = {"n8n": N8N, "vf": VOICEFLOW}[engine]
    # nearest defined band fee for this volume
    band = min(cfg["plan_by_band"], key=lambda b: abs(b - volume))
    return round(cfg["plan_by_band"][band] + volume * cfg["per_conv_usd"], 2)


def table() -> str:
    cols = " | ".join(f"{b:>6}" for b in VOLUME_BANDS)
    lines = [
        f"| Engine | {cols} |",
        "|--------|" + "--------|" * len(VOLUME_BANDS),
    ]
    for eng, label in (("n8n", "n8n+Claude"), ("vf", "Voiceflow")):
        cells = " | ".join(
            f"${monthly_cost(eng, b):>5.0f}" for b in VOLUME_BANDS
        )
        lines.append(f"| {label} | {cells} |")
    lines.append("")
    lines.append("_Shared Claude+Voyage per-conversation cost is identical "
                 "on both engines and excluded. Voiceflow paid-tier figures "
                 "are projections (free/sandbox account) — replace with a "
                 "real quote before the pilot decision is locked._")
    return "\n".join(lines)


if __name__ == "__main__":
    print(table())
