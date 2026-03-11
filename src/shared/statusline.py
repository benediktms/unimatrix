#!/usr/bin/env python3
"""Unimatrix status line for Claude Code.

Reads JSON from stdin and renders a Borg-themed status line.
"""

import glob
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

# Burn rate thresholds per model tier: (green_below, yellow_below, red_at_and_above)
# Also used for health indicator cost scoring (best, worst)
BURN_RATE_THRESHOLDS = {
    "opus":   {"green": 15, "red": 40, "health_best": 10, "health_worst": 50},
    "sonnet": {"green": 5,  "red": 15, "health_best": 3,  "health_worst": 20},
    "haiku":  {"green": 2,  "red": 6,  "health_best": 1,  "health_worst": 8},
}


def detect_tier(model_str):
    """Detect pricing tier from model display name."""
    model_lower = model_str.lower()
    for tier in ("opus", "sonnet", "haiku"):
        if tier in model_lower:
            return tier
    return "sonnet"

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


_last_cleanup = 0


def _cleanup_stale_state(now):
    """Delete /tmp/unimatrix-*.json files older than 24 hours.

    Throttled to run at most once per session (tracked via module global).
    """
    global _last_cleanup
    if _last_cleanup > 0:
        return
    _last_cleanup = now

    ttl = 86400
    for path in glob.glob("/tmp/unimatrix-*.json"):
        try:
            if now - os.path.getmtime(path) > ttl:
                os.unlink(path)
        except (IOError, OSError):
            pass


def get_context_trend(session_id, current_pct):
    """Track context % over time and return trend arrow (↗/→/↘).

    Maintains a ring buffer of (timestamp, pct) samples in a state file.
    Compares current pct to the value ~60s ago to determine trend direction.
    """
    if not session_id:
        return ""
    state_path = f"/tmp/unimatrix-ctx-{session_id}.json"
    now = time.time()

    # Load existing samples
    samples = []
    try:
        with open(state_path, "r") as f:
            samples = json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        pass

    # Debounce: only record a new sample every 10s
    last_ts = samples[-1][0] if samples else 0
    if now - last_ts >= 10:
        samples.append([now, current_pct])

        # Keep only samples from the last 5 minutes
        cutoff = now - 300
        samples = [s for s in samples if s[0] >= cutoff]

        # Write back (best-effort, non-atomic is fine for this)
        try:
            with open(state_path, "w") as f:
                json.dump(samples, f)
        except (IOError, OSError):
            pass

        # Opportunistic cleanup: purge stale state files (>24h old)
        # Runs at most once per 10s debounce, piggybacks on the write
        _cleanup_stale_state(now)

    # Need at least 30s of history for a meaningful trend
    if not samples or (now - samples[0][0]) < 30:
        return ""

    # Find the sample closest to 60s ago (or oldest if less history)
    target = now - 60
    ref = min(samples, key=lambda s: abs(s[0] - target))
    delta = current_pct - ref[1]
    elapsed_min = (now - ref[0]) / 60

    if elapsed_min < 0.5:
        return ""

    rate = delta / elapsed_min  # pct points per minute

    if rate > 2:
        return f"{RED}↗{RESET}"
    elif rate < -2:
        return f"{GREEN}↘{RESET}"
    else:
        return f"{DIM}→{RESET}"


def session_health(pct, cache_pct, burn_rate, tier="sonnet"):
    """Compute a composite session health indicator (⏣).

    Scores three signals 0-1 (higher = healthier):
    - Context headroom: how much context is left
    - Cache efficiency: how well the cache is being used
    - Cost efficiency: how reasonable the burn rate is (tier-adjusted)
    Returns a colored ⏣ symbol.
    """
    thresholds = BURN_RATE_THRESHOLDS.get(tier, BURN_RATE_THRESHOLDS["sonnet"])

    # Context headroom: 0% used = 1.0, 100% used = 0.0
    ctx_score = max(0, (100 - pct)) / 100

    # Cache efficiency: 90%+ = 1.0, 0% = 0.0
    cache_score = min(1.0, (cache_pct or 0) / 90)

    # Cost efficiency: scaled to tier thresholds
    best = thresholds["health_best"]
    worst = thresholds["health_worst"]
    if burn_rate is not None and burn_rate >= 0:
        cost_score = max(0, min(1.0, (worst - burn_rate) / (worst - best)))
    else:
        cost_score = 0.5  # neutral if no data

    # Weighted average (context matters most since it limits the session)
    score = ctx_score * 0.5 + cache_score * 0.3 + cost_score * 0.2

    if score >= 0.7:
        return f"{GREEN}⏣{RESET}"
    elif score >= 0.4:
        return f"{YELLOW}⏣{RESET}"
    else:
        return f"{RED}⏣{RESET}"


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
    if session_id:
        try:
            state_path = f"/tmp/unimatrix-costs-{session_id}.json"
            with open(state_path, "r") as f:
                cost_state = json.load(f)
            subagent_cost = cost_state.get("total_subagent_cost_usd", 0)
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
    bar = progress_bar(pct)
    ctx_col = color_for_pct(pct)

    parts = []
    if repo_name or branch:
        git_ref = f"{repo_name}:{branch}" if repo_name and branch else repo_name or branch
        parts.append(f"\033[95m{git_ref}{RESET}")
    if agent in AGENT_STYLES:
        style, label = AGENT_STYLES[agent]
        parts.append(f"{style}[{label}]{RESET}")
    parts.append(f"{DIM}{model}{RESET}")

    # Session duration
    session_start = get_session_start(transcript)
    if session_start:
        elapsed = time.time() - session_start
        parts.append(f"{YELLOW}{format_duration(elapsed)}{RESET}")

    compactions = get_compaction_count(session_id)
    trend = get_context_trend(session_id, pct)
    ctx_str = f"{bar} {ctx_col}{pct}%{RESET}"
    if trend:
        ctx_str += f" {trend}"
    if compactions > 0:
        ctx_str += f" {DIM}({compactions}x compact){RESET}"
    parts.append(ctx_str)

    cache_pct_val = 0
    if input_tok > 0 or output_tok > 0:
        tok_parts = [f"↓{format_tokens(output_tok)}", f"↑{format_tokens(input_tok)}"]
        total_input = cache_read + cache_create + current_usage.get("input_tokens", 0)
        if total_input > 0:
            cache_pct_val = cache_read / total_input * 100
            cache_col = GREEN if cache_pct_val >= 80 else YELLOW if cache_pct_val >= 50 else RED
            tok_parts.append(f"{cache_col}⚡{cache_pct_val:.1f}%{RESET}{DIM}")
        # Tokens per minute throughput (output tokens / elapsed minutes)
        if session_start:
            elapsed_min = (time.time() - session_start) / 60
            if elapsed_min >= 1:
                tpm = int(output_tok / elapsed_min)
                tpm_col = GREEN if tpm >= 500 else YELLOW if tpm >= 200 else DIM
                tok_parts.append(f"{tpm_col}{format_tokens(tpm)}/min{RESET}{DIM}")
        parts.append(f"{DIM}{' '.join(tok_parts)}{RESET}")

    tier = detect_tier(model)
    thresholds = BURN_RATE_THRESHOLDS.get(tier, BURN_RATE_THRESHOLDS["sonnet"])

    burn_rate = None
    if cost_usd > 0:
        cost_str = f"${cost_usd:.2f}"
        if subagent_cost > 0:
            cost_str += f" (+${subagent_cost:.2f})"
        # Burn rate ($/hr) based on total cost and session duration
        total_cost = cost_usd + subagent_cost
        if session_start:
            elapsed_hrs = (time.time() - session_start) / 3600
            if elapsed_hrs > 0.083:  # at least ~5min to avoid wild initial rates
                burn_rate = total_cost / elapsed_hrs
                if burn_rate < thresholds["green"]:
                    rate_col = GREEN
                elif burn_rate < thresholds["red"]:
                    rate_col = YELLOW
                else:
                    rate_col = RED
                cost_str += f"  {rate_col}~${burn_rate:.2f}/hr{RESET}{DIM}"
        parts.append(f"{DIM}{cost_str}{RESET}")

    # Session health indicator (composite of context, cache, cost)
    parts.append(session_health(pct, cache_pct_val, burn_rate, tier))

    print("  ".join(parts))


if __name__ == "__main__":
    main()
