#!/usr/bin/env python3
"""Unimatrix status line for Claude Code.

Reads JSON from stdin, parses transcript for active subagents,
and renders a Borg-themed status line.
"""

import json
import os
import sys
import time

# ANSI codes
DIM = "\033[2m"
BOLD = "\033[1m"
GREEN = "\033[32m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
RED = "\033[31m"
MAGENTA = "\033[35m"
RESET = "\033[0m"

AGENT_STYLES = {
    "queen": (MAGENTA + BOLD, "QUEEN"),
    "drone": (GREEN + BOLD, "DRONE"),
    "adjunct": (CYAN + BOLD, "ADJUNCT"),
    "probe": (YELLOW + BOLD, "PROBE"),
    "subroutine": (DIM, "SUBROUTINE"),
}

# Model tier indicators: uppercase = Opus, lowercase = Sonnet, dim lowercase = Haiku
MODEL_TIER = {
    "opus": lambda name: name[0].upper(),
    "sonnet": lambda name: name[0].lower(),
    "haiku": lambda name: DIM + name[0].lower() + RESET,
}


def get_tier_code(agent_name, model_hint=""):
    """Single-char code for an agent, case-encoded by model tier."""
    style = AGENT_STYLES.get(agent_name, (DIM, agent_name.upper()))
    label = style[1]
    model = model_hint.lower()
    for tier, fmt in MODEL_TIER.items():
        if tier in model:
            return fmt(label)
    return label[0]


def parse_active_agents(transcript_path):
    """Parse JSONL transcript tail to find active subagents."""
    if not transcript_path or not os.path.exists(transcript_path):
        return []

    try:
        size = os.path.getsize(transcript_path)
        read_bytes = min(size, 512 * 1024)  # tail 512KB like OMC

        with open(transcript_path, "r") as f:
            if size > read_bytes:
                f.seek(size - read_bytes)
                f.readline()  # skip partial line
            lines = f.readlines()
    except (IOError, OSError):
        return []

    # Track agent tool_use calls and their results
    pending = {}  # tool_use_id -> {name, start_time, model}
    completed = set()

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg = entry.get("message", {})
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue

            # Detect Agent tool_use (subagent spawn)
            if block.get("type") == "tool_use" and block.get("name") == "Agent":
                tool_id = block.get("id", "")
                inp = block.get("input", {})
                agent_name = inp.get("subagent_type") or inp.get("name") or "agent"
                # Normalize known agent names
                desc = (inp.get("description", "") + " " + inp.get("prompt", "")).lower()
                for known in AGENT_STYLES:
                    if known in agent_name.lower() or known in desc:
                        agent_name = known
                        break
                pending[tool_id] = {
                    "name": agent_name,
                    "ts": entry.get("timestamp", ""),
                    "desc": inp.get("description", ""),
                }

            # Detect tool_result (subagent completed)
            if block.get("type") == "tool_result":
                tool_id = block.get("tool_use_id", "")
                if tool_id in pending:
                    completed.add(tool_id)

    # Active = spawned but not yet completed
    active = []
    now = time.time()
    for tool_id, info in pending.items():
        if tool_id not in completed:
            # Estimate duration from timestamp
            duration = ""
            if info["ts"]:
                try:
                    from datetime import datetime, timezone
                    ts = datetime.fromisoformat(info["ts"].replace("Z", "+00:00"))
                    elapsed = int(now - ts.timestamp())
                    if elapsed >= 60:
                        duration = f"{elapsed // 60}m"
                    elif elapsed >= 10:
                        duration = f"{elapsed}s"
                except (ValueError, TypeError):
                    pass
            active.append({
                "name": info["name"],
                "duration": duration,
                "desc": info.get("desc", ""),
            })

    return active


def ctx_color(pct):
    if pct >= 80:
        return RED
    elif pct >= 50:
        return YELLOW
    return GREEN


def format_tokens(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


def main():
    data = json.load(sys.stdin)

    model = data.get("model", {}).get("display_name", "?")
    agent = data.get("agent", {}).get("name", "")
    pct = int(data.get("context_window", {}).get("used_percentage", 0) or 0)
    transcript = data.get("transcript_path", "")

    cost = data.get("cost", {})
    total_tokens = (cost.get("total_input_tokens", 0) or 0) + (cost.get("total_output_tokens", 0) or 0)
    cost_usd = cost.get("total_cost_usd", 0) or 0

    # Main agent designation
    style, label = AGENT_STYLES.get(agent, (DIM, "UNIMATRIX"))
    line1 = f"{style}[{label}]{RESET} {DIM}{model}{RESET} {ctx_color(pct)}{pct}%{RESET}"

    # Token/cost suffix
    parts = []
    if total_tokens > 0:
        parts.append(f"{format_tokens(total_tokens)}tok")
    if cost_usd > 0:
        parts.append(f"${cost_usd:.2f}")
    if parts:
        line1 += f" {DIM}{' '.join(parts)}{RESET}"

    print(line1)

    # Active subagents from transcript
    active = parse_active_agents(transcript)
    if active:
        for i, a in enumerate(active):
            connector = "└─" if i == len(active) - 1 else "├─"
            name = a["name"]
            style_a, label_a = AGENT_STYLES.get(name, (DIM, name.upper()))
            dur = f" {DIM}{a['duration']}{RESET}" if a["duration"] else ""
            desc = f" {DIM}{a['desc']}{RESET}" if a.get("desc") else ""
            print(f" {DIM}{connector}{RESET} {style_a}{label_a}{RESET}{dur}{desc}")


if __name__ == "__main__":
    main()
