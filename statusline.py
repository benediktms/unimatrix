#!/usr/bin/env python3
"""Unimatrix status line for Claude Code.

Reads JSON from stdin, parses transcript for active subagents,
and renders a Borg-themed status line.
"""

import json
import os
import re
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

# Matches "Seven of Nine — desc" or "Three of Five, Tertiary Adjunct... — desc"
DESIGNATION_RE = re.compile(
    r"^(\w+ of \w+)(?:,\s*\w+ Adjunct of Unimatrix Zero)?\s*(?:—|-)\s*(.*)$",
    re.IGNORECASE,
)

STALE_SECONDS = 30 * 60  # 30 minutes


def parse_active_agents(transcript_path):
    """Parse JSONL transcript tail to find active subagents."""
    if not transcript_path or not os.path.exists(transcript_path):
        return []

    try:
        size = os.path.getsize(transcript_path)
        read_bytes = min(size, 512 * 1024)  # tail 512KB

        with open(transcript_path, "r") as f:
            if size > read_bytes:
                f.seek(size - read_bytes)
                f.readline()  # skip partial line
            lines = f.readlines()
    except (IOError, OSError):
        return []

    pending = {}
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

            if block.get("type") == "tool_use" and block.get("name") == "Agent":
                tool_id = block.get("id", "")
                inp = block.get("input", {})
                agent_name = inp.get("subagent_type") or inp.get("name") or "agent"
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

            if block.get("type") == "tool_result":
                tool_id = block.get("tool_use_id", "")
                if tool_id in pending:
                    completed.add(tool_id)

    active = []
    now = time.time()
    for tool_id, info in pending.items():
        if tool_id not in completed:
            elapsed = 0
            duration = ""
            if info["ts"]:
                try:
                    from datetime import datetime
                    ts = datetime.fromisoformat(info["ts"].replace("Z", "+00:00"))
                    elapsed = int(now - ts.timestamp())
                    if elapsed >= 60:
                        duration = f"{elapsed // 60}m"
                    elif elapsed >= 10:
                        duration = f"{elapsed}s"
                except (ValueError, TypeError):
                    pass

            # Skip stale agents (>30min likely orphaned)
            if elapsed > STALE_SECONDS:
                continue

            # Parse designation from description
            desc = info.get("desc", "")
            designation = ""
            task_desc = desc
            m = DESIGNATION_RE.match(desc)
            if m:
                designation = m.group(1)
                task_desc = m.group(2)

            active.append({
                "name": info["name"],
                "duration": duration,
                "designation": designation,
                "desc": task_desc,
                "stale": elapsed > STALE_SECONDS,
            })

    return active


def color_for_pct(pct):
    if pct >= 80:
        return RED
    if pct >= 50:
        return YELLOW
    return GREEN


def progress_bar(pct, width=12):
    """Render a compact progress bar with color based on fill percentage."""
    filled = round(pct / 100 * width)
    empty = width - filled
    color = color_for_pct(pct)
    bar = "█" * filled + "░" * empty
    return f"{color}{bar}{RESET}"


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

    cost_data = data.get("cost", {})
    input_tok = cost_data.get("total_input_tokens", 0) or 0
    output_tok = cost_data.get("total_output_tokens", 0) or 0
    cache_read = cost_data.get("total_cache_read_tokens", 0) or 0
    cache_create = cost_data.get("total_cache_creation_tokens", 0) or 0
    cost_usd = cost_data.get("total_cost_usd", 0) or 0

    # Single line: [AGENT] model | ▐bar▌ ctx% | ↓out ↑in ⚡cache | $cost
    style, label = AGENT_STYLES.get(agent, (DIM, "UNIMATRIX"))
    bar = progress_bar(pct)
    ctx_col = color_for_pct(pct)

    parts = [f"{style}[{label}]{RESET}", f"{DIM}{model}{RESET}"]
    parts.append(f"{bar} {ctx_col}{pct}%{RESET}")

    if input_tok > 0 or output_tok > 0:
        tok_parts = [f"↓{format_tokens(output_tok)}", f"↑{format_tokens(input_tok)}"]
        if cache_read > 0:
            tok_parts.append(f"⚡{format_tokens(cache_read)}")
        if cache_create > 0:
            tok_parts.append(f"✎{format_tokens(cache_create)}")
        parts.append(f"{DIM}{' '.join(tok_parts)}{RESET}")

    if cost_usd > 0:
        parts.append(f"{DIM}${cost_usd:.2f}{RESET}")

    print("  ".join(parts))

    # Active subagents from transcript
    active = parse_active_agents(transcript)
    if active:
        for i, a in enumerate(active):
            connector = "└─" if i == len(active) - 1 else "├─"
            name = a["name"]
            style_a, label_a = AGENT_STYLES.get(name, (DIM, name.upper()))
            tag = f"{label_a} {a['designation']}" if a.get("designation") else label_a
            dur = f" {DIM}{a['duration']}{RESET}" if a["duration"] else ""
            desc = f" {DIM}{a['desc']}{RESET}" if a.get("desc") else ""
            print(f" {DIM}{connector}{RESET} {style_a}[{tag}]{RESET}{dur}{desc}")


if __name__ == "__main__":
    main()
