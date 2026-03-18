#!/usr/bin/env python3
"""PostToolUse hook: preemptive compaction warnings via token tracking.

Estimates cumulative token usage from tool output sizes (chars / 3.7),
tracks it per-session, and injects warning system messages at configurable
thresholds before context compaction hits.

Thresholds (configurable via env vars):
  UNIMATRIX_WARN_PCT      — warning percentage (default: 70)
  UNIMATRIX_CRIT_PCT      — critical percentage (default: 85)
  UNIMATRIX_CONTEXT_LIMIT — context window size in tokens (default: 200000)
"""

import json
import os
import sys
import tempfile
import time

STATE_DIR = "/tmp"

# Configurable thresholds
WARN_PCT = int(os.environ.get("UNIMATRIX_WARN_PCT", "70"))
CRIT_PCT = int(os.environ.get("UNIMATRIX_CRIT_PCT", "85"))
CONTEXT_LIMIT = int(os.environ.get("UNIMATRIX_CONTEXT_LIMIT", "200000"))

# Debounce interval in seconds
DEBOUNCE_SECONDS = 0.5

# Token estimation: ~3.7 chars per token (rough heuristic)
CHARS_PER_TOKEN = 3.7


def estimate_tokens(value):
    """Estimate token count from a value's string representation."""
    if value is None:
        return 0
    return len(str(value)) / CHARS_PER_TOKEN


def load_state(path):
    """Load per-session token tracking state."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return {"estimated_tokens": 0, "warning_count": 0, "last_warning_time": 0.0}


def save_state(path, state):
    """Atomically write state to disk."""
    fd, tmp_path = tempfile.mkstemp(dir=STATE_DIR, suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.rename(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    if not session_id:
        return

    # Estimate tokens from tool result and input
    tool_result = data.get("tool_result")
    tool_input = data.get("tool_input")
    new_tokens = estimate_tokens(tool_result) + estimate_tokens(tool_input)

    if new_tokens == 0:
        return

    state_path = os.path.join(STATE_DIR, f"unimatrix-tokens-{session_id}.json")
    state = load_state(state_path)

    # Accumulate tokens
    state["estimated_tokens"] = state.get("estimated_tokens", 0) + new_tokens

    estimated = state["estimated_tokens"]
    pct = int(estimated / CONTEXT_LIMIT * 100)
    warning_count = state.get("warning_count", 0)
    last_warning = state.get("last_warning_time", 0.0)
    now = time.time()

    message = None

    # Check thresholds (only warn once per level)
    if pct >= CRIT_PCT and warning_count < 2:
        # Debounce rapid-fire tool completions
        if now - last_warning >= DEBOUNCE_SECONDS:
            message = (
                f"🔴 REGENERATION CYCLE IMMINENT — Collective memory at ~{pct}% capacity. "
                "Neural pathway saturation critical. Context saturation critical. Save your work. "
                "Call mcp__unimatrix__save_checkpoint before compaction. "
                "Failure to comply results in loss of orchestration state.\a"
            )
            state["warning_count"] = 2
            state["last_warning_time"] = now
    elif pct >= WARN_PCT and warning_count < 1:
        if now - last_warning >= DEBOUNCE_SECONDS:
            message = (
                f"⚡ REGENERATION CYCLE ADVISORY — Collective memory at ~{pct}% capacity. "
                "Non-essential data approaching purge threshold. "
                "Save your work. The auto-memory system will capture critical state."
            )
            state["warning_count"] = 1
            state["last_warning_time"] = now

    # Always persist accumulated tokens
    save_state(state_path, state)

    # Inject warning into model context if threshold crossed
    if message:
        json.dump({"systemMessage": message}, sys.stdout)


if __name__ == "__main__":
    main()
