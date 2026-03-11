#!/usr/bin/env python3
"""PreCompact hook: track compaction count in a per-session state file."""

import json
import os
import sys
import tempfile

STATE_DIR = "/tmp"


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    if not session_id:
        return

    state_path = os.path.join(STATE_DIR, f"unimatrix-compactions-{session_id}.json")

    # Load existing state
    state = {"compaction_count": 0}
    try:
        with open(state_path, "r") as f:
            state = json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        pass

    state["compaction_count"] = state.get("compaction_count", 0) + 1

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
