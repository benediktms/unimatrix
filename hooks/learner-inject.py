#!/usr/bin/env python3
"""UserPromptSubmit hook: inject relevant error/fix patterns from Brain memory.

Reads the learner state file written by learner-track.py. If there are
recent pending errors, searches Brain for matching auto-learn episodes and
injects them as additionalContext so the model can apply known fixes.

After injection, matched errors are cleared from the state file so the same
patterns do not trigger injection on every subsequent prompt.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

STATE_DIR = "/tmp"
BRAIN_CLI = "/Users/benedikt.schnatterbeck/bin/brain"
SUBPROCESS_TIMEOUT = 5  # seconds

# Errors older than this are considered stale and skipped
STALE_SECONDS = 300

# Minimum similarity score required to include a Brain episode
MIN_SCORE = 0.5

# Maximum total characters of injected context
MAX_CONTEXT_CHARS = 2000


def load_json_file(path):
    """Load a JSON file, returning None on any failure."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return None


def atomic_write(path, data):
    """Atomically write a JSON object to path via temp file + rename."""
    dir_path = os.path.dirname(path) or STATE_DIR
    fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.rename(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def call_brain_mcp(method, params):
    """Call a brain MCP method via JSON-RPC on stdin/stdout. Returns result or None."""
    request = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
    try:
        result = subprocess.run(
            [BRAIN_CLI, "mcp"],
            input=request,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
            stdin=subprocess.PIPE,
        )
        if result.returncode != 0:
            return None
        response = json.loads(result.stdout)
        return response.get("result")
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def search_brain(query):
    """Search Brain memory for episodes matching query, tagged auto-learn.

    Returns a list of episode dicts or an empty list on any failure.
    """
    result = call_brain_mcp(
        "memory_search_minimal",
        {"query": query, "intent": "lookup", "tags": ["auto-learn"]},
    )
    if not result:
        return []
    items = result if isinstance(result, list) else result.get("results", [])
    if isinstance(items, list):
        return items
    return []


def format_context(episodes):
    """Build the additionalContext string from a list of matching episodes.

    Returns None if episodes list is empty.
    Caps total output at MAX_CONTEXT_CHARS.
    """
    if not episodes:
        return None

    header = (
        "[UNIMATRIX AUTO-LEARNER] Relevant error/fix patterns from previous sessions:\n"
    )
    footer = "\n---\n(Patterns are auto-captured. Verify applicability before applying.)"

    body_parts = []
    for i, episode in enumerate(episodes, start=1):
        score = episode.get("score", 0.0)
        body = episode.get("body", "").strip()
        if not body:
            continue
        body_parts.append(
            f"\n### Pattern {i} (confidence: {score:.2f})\n{body}"
        )

    if not body_parts:
        return None

    raw = header + "\n".join(body_parts) + footer

    # Cap to avoid context bloat
    if len(raw) > MAX_CONTEXT_CHARS:
        raw = raw[:MAX_CONTEXT_CHARS - 3] + "..."

    return raw


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    if not session_id:
        return

    state_path = os.path.join(STATE_DIR, f"unimatrix-learner-{session_id}.json")
    state = load_json_file(state_path)

    # Early exit: no state file or empty state
    if not state:
        return

    pending_errors = state.get("pending_errors", [])
    if not pending_errors:
        return

    # Filter out stale errors
    now = time.time()
    fresh_errors = [
        e for e in pending_errors
        if now - e.get("timestamp", 0) <= STALE_SECONDS
    ]
    if not fresh_errors:
        return

    # Use the most recent fresh error as the search query
    most_recent = max(fresh_errors, key=lambda e: e.get("timestamp", 0))
    query = most_recent.get("error_summary", "").strip()
    if not query:
        return

    # Search Brain for matching patterns
    episodes = search_brain(query)

    # Filter by minimum similarity score
    matching = [e for e in episodes if e.get("score", 0.0) > MIN_SCORE]
    if not matching:
        return

    # Format context string
    context = format_context(matching)
    if not context:
        return

    # Emit additionalContext to stdout
    json.dump({"additionalContext": context}, sys.stdout)

    # Cleanup: remove the fresh errors that triggered this injection from state
    matched_summaries = {e.get("error_summary") for e in fresh_errors}
    remaining = [
        e for e in pending_errors
        if e.get("error_summary") not in matched_summaries
    ]
    state["pending_errors"] = remaining
    atomic_write(state_path, state)


if __name__ == "__main__":
    main()
