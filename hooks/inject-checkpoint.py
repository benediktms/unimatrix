#!/usr/bin/env python3
"""UserPromptSubmit hook: inject post-compaction checkpoint into context.

Checks for a pending checkpoint file written by checkpoint-state.py.
If found, reads it, deletes it (one-shot), and returns it as additionalContext
so the model regains awareness of orchestration state after compaction.
"""

import json
import os
import sys

STATE_DIR = "/tmp"


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    if not session_id:
        return

    checkpoint_path = os.path.join(STATE_DIR, f"unimatrix-checkpoint-{session_id}.md")

    if not os.path.exists(checkpoint_path):
        return

    try:
        with open(checkpoint_path, "r") as f:
            content = f.read()
    except (IOError, OSError):
        return

    if not content.strip():
        try:
            os.unlink(checkpoint_path)
        except OSError:
            pass
        return

    # Consume the checkpoint (one-shot injection)
    try:
        os.unlink(checkpoint_path)
    except OSError:
        pass

    # Return additionalContext for Claude Code to inject as a system-reminder
    result = {"additionalContext": content}
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
