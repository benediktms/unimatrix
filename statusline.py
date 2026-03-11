#!/usr/bin/env python3
"""Unimatrix status line for Claude Code.

Reads JSON from stdin and renders a Borg-themed status line.
Active subagents are tracked via hooks (track-agents.py).
"""

import json
import os
import subprocess
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
    "Queen": (MAGENTA + BOLD, "QUEEN"),
    "Drone": (GREEN + BOLD, "DRONE"),
    "Vinculum": (CYAN + BOLD, "VINCULUM"),
    "Probe": (YELLOW + BOLD, "PROBE"),
    "Cortex": (CYAN + BOLD, "CORTEX"),
    "Subroutine": (DIM, "SUBROUTINE"),
}

STALE_SECONDS = 15 * 60  # 15 minutes


def get_compaction_count(session_id):
    """Read compaction count from the state file written by track-compactions.py."""
    if not session_id:
        return 0
    try:
        path = f"/tmp/unimatrix-compactions-{session_id}.json"
        with open(path, "r") as f:
            state = json.load(f)
        return state.get("compaction_count", 0)
    except (IOError, OSError, json.JSONDecodeError):
        return 0


def get_active_agents(session_id):
    """Read active subagents from the state file written by track-agents.py."""
    if not session_id:
        return []

    try:
        path = f"/tmp/unimatrix-agents-{session_id}.json"
        with open(path, "r") as f:
            state = json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return []

    active = []
    now = time.time()
    for agent_id, info in state.get("active", {}).items():
        started_at = info.get("started_at", 0)
        elapsed = int(now - started_at) if started_at else 0

        # Skip stale agents (>30min likely orphaned)
        if elapsed > STALE_SECONDS:
            continue

        if elapsed >= 60:
            duration = f"{elapsed // 60}m"
        elif elapsed >= 10:
            duration = f"{elapsed}s"
        else:
            duration = ""

        active.append({
            "name": info.get("type", "agent"),
            "duration": duration,
        })

    return active


def get_session_start(transcript_path):
    """Get session start time from first timestamped transcript entry."""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        from datetime import datetime
        with open(transcript_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                ts = entry.get("timestamp", "")
                if ts:
                    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (IOError, OSError, json.JSONDecodeError, ValueError):
        pass
    return None


def format_duration(seconds):
    """Format seconds into a human-readable duration."""
    seconds = int(seconds)
    if seconds >= 3600:
        return f"{seconds // 3600}h{(seconds % 3600) // 60}m"
    if seconds >= 60:
        return f"{seconds // 60}m"
    return f"{seconds}s"


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

    ctx_data = data.get("context_window", {})
    input_tok = ctx_data.get("total_input_tokens", 0) or 0
    output_tok = ctx_data.get("total_output_tokens", 0) or 0
    current_usage = ctx_data.get("current_usage") or {}
    cache_read = current_usage.get("cache_read_input_tokens", 0) or 0
    cache_create = current_usage.get("cache_creation_input_tokens", 0) or 0
    cost_usd = data.get("cost", {}).get("total_cost_usd", 0) or 0
    session_id = data.get("session_id", "")

    # Read subagent cost state
    subagent_cost = 0
    type_counts = {}
    if session_id:
        try:
            state_path = f"/tmp/unimatrix-costs-{session_id}.json"
            with open(state_path, "r") as f:
                cost_state = json.load(f)
            subagent_cost = cost_state.get("total_subagent_cost_usd", 0)
            type_counts = cost_state.get("type_counts", {})
        except (IOError, OSError, json.JSONDecodeError, KeyError):
            pass

    # Git repo and branch
    branch = ""
    repo_name = ""
    try:
        branch = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            stderr=subprocess.DEVNULL, text=True
        ).strip()
        toplevel = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL, text=True
        ).strip()
        repo_name = os.path.basename(toplevel)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    # Single line: [AGENT] model | branch | ▐bar▌ ctx% | ↓out ↑in ⚡cache | $cost
    style, label = AGENT_STYLES.get(agent, (DIM, "UNIMATRIX"))
    bar = progress_bar(pct)
    ctx_col = color_for_pct(pct)

    parts = []
    if repo_name or branch:
        git_ref = f"{repo_name}:{branch}" if repo_name and branch else repo_name or branch
        parts.append(f"\033[95m{git_ref}{RESET}")
    parts.extend([f"{style}[{label}]{RESET}", f"{DIM}{model}{RESET}"])

    # Session duration
    session_start = get_session_start(transcript)
    if session_start:
        elapsed = time.time() - session_start
        parts.append(f"{YELLOW}{format_duration(elapsed)}{RESET}")

    compactions = get_compaction_count(session_id)
    ctx_str = f"{bar} {ctx_col}{pct}%{RESET}"
    if compactions > 0:
        ctx_str += f" {DIM}({compactions}x compact){RESET}"
    parts.append(ctx_str)

    if input_tok > 0 or output_tok > 0:
        tok_parts = [f"↓{format_tokens(output_tok)}", f"↑{format_tokens(input_tok)}"]
        total_input = cache_read + cache_create + current_usage.get("input_tokens", 0)
        if total_input > 0:
            cache_pct = cache_read / total_input * 100
            cache_col = GREEN if cache_pct >= 80 else YELLOW if cache_pct >= 50 else RED
            tok_parts.append(f"{cache_col}⚡{cache_pct:.1f}%{RESET}{DIM}")
        parts.append(f"{DIM}{' '.join(tok_parts)}{RESET}")

    if cost_usd > 0:
        cost_str = f"${cost_usd:.2f}"
        if subagent_cost > 0:
            cost_str += f" (+${subagent_cost:.2f})"
        parts.append(f"{DIM}{cost_str}{RESET}")

    # Subagent type counts
    if type_counts:
        TYPE_ORDER = ["Drone", "Probe", "Vinculum", "Cortex", "Subroutine", "Queen"]
        count_parts = []
        seen = set()
        for t in TYPE_ORDER:
            n = type_counts.get(t, 0)
            if n > 0:
                label_t = t + ("s" if n != 1 else "")
                count_parts.append(f"{GREEN}{n} {label_t}{RESET}")
                seen.add(t)
        for t in sorted(type_counts):
            if t not in seen:
                n = type_counts[t]
                label_t = t + ("s" if n != 1 else "")
                count_parts.append(f"{DIM}{n} {label_t}{RESET}")
        if count_parts:
            parts.append(f"{' \u00b7 '.join(count_parts)}")

    print("  ".join(parts))

    # Active subagents from state file
    active = get_active_agents(session_id)
    if active:
        for i, a in enumerate(active):
            connector = "└─" if i == len(active) - 1 else "├─"
            name = a["name"]
            style_a, label_a = AGENT_STYLES.get(name, (DIM, name.upper()))
            dur = f" {DIM}{a['duration']}{RESET}" if a["duration"] else ""
            print(f" {DIM}{connector}{RESET} {style_a}[{label_a}]{RESET}{dur}")


if __name__ == "__main__":
    main()
