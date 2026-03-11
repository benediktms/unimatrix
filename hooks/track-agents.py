#!/usr/bin/env python3
"""SubagentStart/Stop hook: track active subagents in a per-session state file.

Handles both events based on hook_event_name:
- SubagentStart: records agent as active
- SubagentStop: removes agent from active set
"""

import json
import os
import sys
import tempfile
import time

STATE_DIR = "/tmp"


def state_path(session_id):
    return os.path.join(STATE_DIR, f"unimatrix-agents-{session_id}.json")


def load_state(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return {"active": {}}


def save_state(path, state):
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
    agent_id = data.get("agent_id", "")
    agent_type = data.get("agent_type", "unknown")
    event = data.get("hook_event_name", "")

    if not session_id or not agent_id:
        return

    path = state_path(session_id)
    state = load_state(path)

    if event == "SubagentStart":
        state["active"][agent_id] = {
            "type": agent_type,
            "started_at": time.time(),
        }
    elif event == "SubagentStop":
        agent_info = state["active"].pop(agent_id, None)
        if agent_info and agent_info.get("started_at"):
            duration = time.time() - agent_info["started_at"]
            state.setdefault("total_subagent_seconds", 0)
            state["total_subagent_seconds"] += duration

    save_state(path, state)


if __name__ == "__main__":
    main()
