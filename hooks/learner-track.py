#!/usr/bin/env python3
"""PostToolUse hook: detect error/solution pairs and persist patterns to brain memory.

Tracks tool failures in per-session state. When a subsequent successful tool use
follows a recent failure on the same tool, scores the error/fix pair and persists
high-scoring patterns to brain memory via the brain CLI.

State file: /tmp/unimatrix-learner-{session_id}.json
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time

STATE_DIR = "/tmp"
BRAIN_CLI = "/Users/benedikt.schnatterbeck/bin/brain"
SUBPROCESS_TIMEOUT = 5  # seconds

# Error detection patterns
BASH_ERROR_PATTERNS = [
    "error:",
    "Error:",
    "ERROR",
    "fatal:",
    "Failed",
    "command not found",
    "No such file",
    "Permission denied",
    "traceback",
    "Traceback",
    "Exception",
]

GENERAL_ERROR_PATTERNS = [
    "Traceback (most recent call last)",
    "TypeError:",
    "ValueError:",
    "KeyError:",
    "AttributeError:",
    "ImportError:",
    "ModuleNotFoundError:",
    "SyntaxError:",
    "ReferenceError:",
    "NameError:",
    "RangeError:",
    "error[E",  # Rust errors
    "thread 'main' panicked",  # Rust panics
]

# State schema limits
MAX_PENDING_ERRORS = 5
MAX_ERROR_SUMMARY_CHARS = 500
MAX_INPUT_SUMMARY_CHARS = 200

# Scoring thresholds
SCORE_THRESHOLD = 0.6
RESOLUTION_WINDOW_SECONDS = 120
RECENCY_BONUS_SECONDS = 30

# Rate limiting
MIN_WRITE_INTERVAL_SECONDS = 30

# Dedup threshold
SIMILARITY_THRESHOLD = 0.8

# Technical specificity indicators
TECH_SPECIFICITY_PATTERNS = re.compile(
    r'\.[a-z]{1,6}\b|'           # file extensions
    r'error\s+code\s+\d+|'       # error codes
    r'exit\s+code\s+\d+|'        # exit codes
    r'E\d{4}|'                    # Rust/TypeScript error codes
    r'npm|pip|cargo|brew|apt|'    # package managers
    r'pytest|jest|mocha|rspec|'   # test runners
    r'\bBash\b|\bEdit\b|\bWrite\b|\bRead\b|'  # tool names
    r'import\s+\w+|from\s+\w+\s+import',  # import statements
    re.IGNORECASE
)

# Hyper-specific path pattern (e.g., /Users/specific-user/...)
HYPER_SPECIFIC_PATH = re.compile(r'/(?:Users|home)/[^/\s]+/')


def state_path(session_id):
    return os.path.join(STATE_DIR, f"unimatrix-learner-{session_id}.json")


def load_state(path):
    """Load per-session learner state, resetting on corruption."""
    try:
        with open(path, "r") as f:
            state = json.load(f)
        # Validate expected keys
        if not isinstance(state, dict):
            raise ValueError("state is not a dict")
        return state
    except (IOError, OSError, json.JSONDecodeError, ValueError):
        return {
            "pending_errors": [],
            "patterns_written": 0,
            "last_write_time": 0.0,
        }


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


def result_to_text(tool_result):
    """Convert tool_result to a flat string for pattern matching."""
    if tool_result is None:
        return ""
    if isinstance(tool_result, str):
        return tool_result
    if isinstance(tool_result, dict):
        # Claude Code wraps Bash results: {"type": "tool_result", "content": [...]}
        content = tool_result.get("content", "")
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    parts.append(item.get("text", ""))
                elif isinstance(item, str):
                    parts.append(item)
            return "\n".join(parts)
        return str(content)
    return str(tool_result)


def is_error(tool_name, tool_result_text):
    """Return True if the tool result indicates a failure."""
    tool_upper = tool_name.upper()

    # Check general error patterns first (apply to all tools)
    for pattern in GENERAL_ERROR_PATTERNS:
        if pattern in tool_result_text:
            return True

    if tool_upper == "BASH":
        for pattern in BASH_ERROR_PATTERNS:
            if pattern in tool_result_text:
                return True

    elif tool_upper in ("EDIT", "WRITE"):
        lower = tool_result_text.lower()
        if "error" in lower or "failed" in lower:
            return True

    return False


def input_to_text(tool_input):
    """Convert tool_input to a summary string."""
    if tool_input is None:
        return ""
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, dict):
        # For Bash: {"command": "..."}, for Edit: {"file_path": "...", ...}
        command = tool_input.get("command", "")
        if command:
            return command
        # Fallback: join all string values
        parts = [str(v) for v in tool_input.values() if isinstance(v, str)]
        return " | ".join(parts)
    return str(tool_input)


def truncate(text, max_chars):
    """Truncate text to max_chars, appending ellipsis if needed."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars - 3] + "..."


def find_matching_error(pending_errors, tool_name, now):
    """Find the most recent pending error matching this tool within the time window."""
    tool_upper = tool_name.upper()
    for i, err in enumerate(reversed(pending_errors)):
        idx = len(pending_errors) - 1 - i
        age = now - err.get("timestamp", 0)
        if age > RESOLUTION_WINDOW_SECONDS:
            continue
        err_tool = err.get("tool_name", "").upper()
        if err_tool == tool_upper:
            return idx, err
    return None, None


def score_pattern(error_entry, resolution_text, resolution_input, now):
    """Score the error/fix pair from 0.0 to 1.0."""
    score = 0.0
    error_summary = error_entry.get("error_summary", "")

    # Technical specificity (+0.3)
    if TECH_SPECIFICITY_PATTERNS.search(error_summary):
        score += 0.3

    # Actionability (+0.3): resolution input is a concrete command or non-trivial edit
    res_input_stripped = resolution_input.strip()
    if len(res_input_stripped) > 10 and res_input_stripped not in ("", "it worked"):
        score += 0.3

    # Generalizability (+0.2): error not hyper-specific to one absolute path
    if not HYPER_SPECIFIC_PATH.search(error_summary):
        score += 0.2

    # Recency bonus (+0.2): fast fix means well-understood pattern
    age = now - error_entry.get("timestamp", 0)
    if age < RECENCY_BONUS_SECONDS:
        score += 0.2

    return round(min(score, 1.0), 2)


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


def is_duplicate(error_summary):
    """Return True if a similar pattern already exists in brain memory."""
    result = call_brain_mcp(
        "memory_search_minimal",
        {"query": error_summary, "intent": "lookup", "tags": ["auto-learn"]},
    )
    if not result:
        return False
    items = result if isinstance(result, list) else result.get("results", [])
    for item in items:
        score = item.get("score", 0.0)
        if score > SIMILARITY_THRESHOLD:
            return True
    return False


def write_episode(error_entry, resolution_text, resolution_input, score):
    """Persist the error/fix pattern to brain memory."""
    error_summary = error_entry.get("error_summary", "")
    tool_name = error_entry.get("tool_name", "")
    tool_input_summary = error_entry.get("tool_input_summary", "")
    resolution_summary = truncate(resolution_text, MAX_ERROR_SUMMARY_CHARS)
    resolution_input_summary = truncate(resolution_input, MAX_INPUT_SUMMARY_CHARS)

    # Build short title from first line of error summary
    short_error = error_summary.split("\n")[0][:60].strip()
    title = f"Fix: {short_error}"

    body = (
        f"## Error\n{error_summary}\n\n"
        f"Tool: {tool_name}\n"
        f"Input: {tool_input_summary}\n\n"
        f"## Resolution\n{resolution_summary}\n\n"
        f"Tool: {tool_name}\n"
        f"Input: {resolution_input_summary}"
    )

    call_brain_mcp(
        "memory_write_episode",
        {
            "title": title,
            "body": body,
            "tags": ["auto-learn", "pattern:error-fix"],
            "importance": score,
        },
    )


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    if not session_id:
        return

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input")
    tool_result = data.get("tool_result")

    result_text = result_to_text(tool_result)
    input_text = input_to_text(tool_input)

    path = state_path(session_id)
    state = load_state(path)

    now = time.time()
    pending_errors = state.get("pending_errors", [])

    if is_error(tool_name, result_text):
        # Record this error in pending state
        error_entry = {
            "tool_name": tool_name,
            "error_summary": truncate(result_text, MAX_ERROR_SUMMARY_CHARS),
            "timestamp": now,
            "tool_input_summary": truncate(input_text, MAX_INPUT_SUMMARY_CHARS),
        }
        pending_errors.append(error_entry)
        # FIFO cap
        if len(pending_errors) > MAX_PENDING_ERRORS:
            pending_errors = pending_errors[-MAX_PENDING_ERRORS:]
        state["pending_errors"] = pending_errors
        save_state(path, state)
        return

    # No error — check if this resolves a pending error
    if not pending_errors:
        return

    error_idx, matched_error = find_matching_error(pending_errors, tool_name, now)
    if matched_error is None:
        return

    # Score the pair
    score = score_pattern(matched_error, result_text, input_text, now)

    if score < SCORE_THRESHOLD:
        # Remove the stale/low-quality error so it doesn't accumulate
        pending_errors.pop(error_idx)
        state["pending_errors"] = pending_errors
        save_state(path, state)
        return

    # Rate limit check
    last_write_time = state.get("last_write_time", 0.0)
    if now - last_write_time < MIN_WRITE_INTERVAL_SECONDS:
        return

    # Deduplication check (best-effort; fail silently if brain unavailable)
    if is_duplicate(matched_error.get("error_summary", "")):
        pending_errors.pop(error_idx)
        state["pending_errors"] = pending_errors
        save_state(path, state)
        return

    # Persist pattern to brain
    write_episode(matched_error, result_text, input_text, score)

    # Update state
    pending_errors.pop(error_idx)
    state["pending_errors"] = pending_errors
    state["patterns_written"] = state.get("patterns_written", 0) + 1
    state["last_write_time"] = now
    save_state(path, state)

    # Informational output to model context
    json.dump(
        {"systemMessage": f"[UNIMATRIX] Auto-learner captured error/fix pattern (score: {score:.2f})"},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
