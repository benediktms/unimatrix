#!/usr/bin/env python3
"""SubagentStop hook: track subagent costs by parsing transcripts.

Reads agent info from stdin, parses the transcript for token usage,
calculates cost, and writes to a per-session state file.
"""

import json
import os
import sys
import tempfile

PRICING = {  # per 1M tokens
    "opus": {"input": 15.0, "output": 75.0, "cache_read": 1.50, "cache_create": 18.75},
    "sonnet": {"input": 3.0, "output": 15.0, "cache_read": 0.30, "cache_create": 3.75},
    "haiku": {"input": 0.80, "output": 4.0, "cache_read": 0.08, "cache_create": 1.00},
}

STATE_DIR = "/tmp"
KNOWN_TYPES = {"Drone", "Probe", "Sentinel", "Designate", "Locutus"}


def normalize_agent_type(raw_type):
    """Extract base agent type from prefixed names like 'Probe: Four of Four'."""
    if ": " in raw_type:
        prefix = raw_type.split(": ", 1)[0]
        if prefix in KNOWN_TYPES:
            return prefix
    return raw_type


def detect_tier(model_str):
    """Detect pricing tier from model string."""
    model_lower = model_str.lower()
    for tier in ("opus", "sonnet", "haiku"):
        if tier in model_lower:
            return tier
    return "sonnet"  # default fallback


def parse_transcript(path):
    """Parse JSONL transcript and return (tier, token_totals)."""
    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    tier = None

    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg = entry.get("message", {})
            if msg.get("role") != "assistant":
                continue

            # Detect model from first assistant message
            if tier is None and msg.get("model"):
                tier = detect_tier(msg["model"])

            usage = msg.get("usage", {})
            for key in totals:
                totals[key] += usage.get(key, 0) or 0

    return tier or "sonnet", totals


def calculate_cost(tier, totals):
    """Calculate USD cost from token totals."""
    prices = PRICING[tier]
    cost = (
        totals["input_tokens"] * prices["input"]
        + totals["output_tokens"] * prices["output"]
        + totals["cache_read_input_tokens"] * prices["cache_read"]
        + totals["cache_creation_input_tokens"] * prices["cache_create"]
    ) / 1_000_000
    return round(cost, 6)


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    transcript_path = data.get("agent_transcript_path", "")
    agent_id = data.get("agent_id", "")
    agent_type = normalize_agent_type(data.get("agent_type", "unknown"))

    if not session_id or not transcript_path or not agent_id:
        return

    transcript_path = os.path.expanduser(transcript_path)
    if not os.path.exists(transcript_path):
        return

    tier, totals = parse_transcript(transcript_path)
    cost = calculate_cost(tier, totals)

    state_path = os.path.join(STATE_DIR, f"unimatrix-costs-{session_id}.json")

    # Load existing state
    state = {"total_subagent_cost_usd": 0, "agents": {}, "type_counts": {}}
    try:
        with open(state_path, "r") as f:
            state = json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        pass

    # Upsert this agent
    state["agents"][agent_id] = {"type": agent_type, "cost_usd": cost}

    # Recalculate totals
    total = 0
    type_counts = {}
    for info in state["agents"].values():
        total += info["cost_usd"]
        t = info["type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    state["total_subagent_cost_usd"] = round(total, 6)
    state["type_counts"] = type_counts

    # Atomic write
    fd, tmp_path = tempfile.mkstemp(dir=STATE_DIR, suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.rename(tmp_path, state_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
