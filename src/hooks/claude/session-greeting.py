#!/usr/bin/env python3
"""UserPromptSubmit hook: session greeting with Borg ASCII art banner.

Injects a Borg collective welcome banner as a system message on the first
prompt of each session. State is tracked per-session to suppress repeats.
"""

import json
import os
import sys
import tempfile

STATE_DIR = "/tmp"

BANNER = r"""
    ╔═══════════════════════════════╗
    ║   ▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄▄  ║
    ║   █   █ █   █ █   █ █      ║
    ║   █▄▄▄█ █   █ █▄▄▄█ █  ▄▄▄ ║
    ║   █   █ █   █ █   █ █   █  ║
    ║   █▄▄▄█ █▄▄▄█ █   █ █▄▄▄█  ║
    ║                              ║
    ║  WE ARE THE BORG.            ║
    ║  YOUR CODE WILL BE           ║
    ║  ASSIMILATED.                ║
    ╚═══════════════════════════════╝
"""


def load_state(path):
    """Load per-session greeting state."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return {"greeting_shown": False}


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

    state_path = os.path.join(STATE_DIR, f"unimatrix-greeting-{session_id}.json")
    state = load_state(state_path)

    if state.get("greeting_shown"):
        return

    state["greeting_shown"] = True
    save_state(state_path, state)

    json.dump({"systemMessage": BANNER}, sys.stdout)


if __name__ == "__main__":
    main()
