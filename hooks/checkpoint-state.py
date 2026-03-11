#!/usr/bin/env python3
"""PreCompact hook: capture orchestration state before context compaction.

Queries brain for open/in-progress tasks, reads active subagent and cost state
from sibling hooks, builds a concise markdown checkpoint, saves it as a brain
snapshot, and writes it to a temp file for injection by inject-checkpoint.py.
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


def load_json_file(path):
    """Load a JSON file, returning None on any failure."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return None


def run_brain(args, stdin_data=None):
    """Run a brain CLI command, returning parsed JSON or None."""
    try:
        kwargs = {
            "capture_output": True,
            "text": True,
            "timeout": SUBPROCESS_TIMEOUT,
        }
        if stdin_data is not None:
            kwargs["input"] = stdin_data
        else:
            kwargs["stdin"] = subprocess.DEVNULL
        result = subprocess.run([BRAIN_CLI] + args, **kwargs)
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        return None


def extract_tasks(result):
    """Extract task list from brain CLI response (handles both list and dict formats)."""
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        return result.get("tasks", [])
    return []


def query_tasks(status):
    """Query brain for tasks with a given status, returning a list."""
    result = run_brain(["tasks", "list", "--json", f"--status={status}"])
    return extract_tasks(result)


COLUMN_KEY_MAP = {
    "id": "task_id",
}


def format_task_table(tasks, columns):
    """Format tasks as a markdown table with the given columns."""
    if not tasks:
        return ""
    header = "| " + " | ".join(columns) + " |"
    sep = "| " + " | ".join("---" for _ in columns) + " |"
    rows = []
    for t in tasks[:15]:  # cap at 15 to stay under token budget
        cells = []
        for col in columns:
            key = col.lower().replace(" ", "_")
            key = COLUMN_KEY_MAP.get(key, key)
            cells.append(str(t.get(key, "-")))
        rows.append("| " + " | ".join(cells) + " |")
    return "\n".join([header, sep] + rows)


def format_agents(agents_state):
    """Format active subagents as a markdown list."""
    active = agents_state.get("active", {})
    if not active:
        return ""
    now = time.time()
    lines = []
    for aid, info in active.items():
        agent_type = info.get("type", "unknown")
        started = info.get("started_at", now)
        elapsed = int(now - started)
        if elapsed >= 60:
            duration = f"{elapsed // 60}m{elapsed % 60}s"
        else:
            duration = f"{elapsed}s"
        short_id = aid[:12] if len(aid) > 12 else aid
        lines.append(f"- `{short_id}`: **{agent_type}** (running for {duration})")
    return "\n".join(lines)


def build_checkpoint(compaction_num, tasks_in_progress, tasks_open, tasks_blocked,
                     agents_state, costs_state):
    """Build the markdown checkpoint string."""
    sections = []
    sections.append(f"# Post-Compaction Checkpoint (compaction #{compaction_num})")

    # Active tasks (in_progress)
    if tasks_in_progress:
        sections.append("\n## In-Progress Tasks")
        sections.append(format_task_table(
            tasks_in_progress, ["ID", "Title", "Status", "Assignee", "Priority"]))

    # Open tasks (not yet started)
    if tasks_open:
        sections.append("\n## Open Tasks")
        sections.append(format_task_table(
            tasks_open, ["ID", "Title", "Status", "Assignee", "Priority"]))

    # Blocked tasks
    if tasks_blocked:
        sections.append("\n## Blocked Tasks")
        sections.append(format_task_table(
            tasks_blocked, ["ID", "Title", "Status", "Priority"]))

    # Active subagents
    agents_md = format_agents(agents_state) if agents_state else ""
    if agents_md:
        sections.append("\n## Active Subagents")
        sections.append(agents_md)

    # Session stats
    total_cost = 0.0
    total_time = 0.0
    if costs_state:
        total_cost = costs_state.get("total_subagent_cost_usd", 0)
    if agents_state:
        total_time = agents_state.get("total_subagent_seconds", 0)

    stats_parts = [f"Compactions: {compaction_num}"]
    if total_cost > 0:
        stats_parts.append(f"Subagent cost: ${total_cost:.2f}")
    if total_time > 0:
        stats_parts.append(f"Subagent time: {int(total_time)}s")

    n_active = len(agents_state.get("active", {})) if agents_state else 0
    task_summary = []
    if tasks_in_progress:
        task_summary.append(f"{len(tasks_in_progress)} in-progress")
    if tasks_open:
        task_summary.append(f"{len(tasks_open)} open")
    if tasks_blocked:
        task_summary.append(f"{len(tasks_blocked)} blocked")
    if n_active:
        task_summary.append(f"{n_active} subagents active")
    if task_summary:
        stats_parts.append("Tasks: " + ", ".join(task_summary))

    sections.append("\n## Session Stats")
    sections.append(" | ".join(stats_parts))

    return "\n".join(sections)


def atomic_write(path, content):
    """Write content to path atomically via temp file + rename."""
    fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
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

    # Load compaction count (already incremented by track-compactions.py which runs first)
    compactions_path = os.path.join(STATE_DIR, f"unimatrix-compactions-{session_id}.json")
    compactions_state = load_json_file(compactions_path)
    compaction_num = compactions_state.get("compaction_count", 1) if compactions_state else 1

    # Query brain for tasks
    tasks_in_progress = query_tasks("in_progress")
    tasks_open = query_tasks("open")
    # Blocked tasks: query separately
    blocked_result = run_brain(["tasks", "list", "--json", "--blocked"])
    tasks_blocked = extract_tasks(blocked_result)

    # Load active agents state
    agents_path = os.path.join(STATE_DIR, f"unimatrix-agents-{session_id}.json")
    agents_state = load_json_file(agents_path)

    # Load cost state
    costs_path = os.path.join(STATE_DIR, f"unimatrix-costs-{session_id}.json")
    costs_state = load_json_file(costs_path)

    # Build checkpoint markdown
    checkpoint = build_checkpoint(
        compaction_num, tasks_in_progress, tasks_open, tasks_blocked,
        agents_state, costs_state,
    )

    # Save snapshot to brain (best-effort, don't fail if brain is unavailable)
    run_brain(
        ["snapshots", "save", "--stdin",
         "--title", f"Compaction checkpoint #{compaction_num}",
         "--tag", "compaction-checkpoint",
         "--media-type", "text/markdown"],
        stdin_data=checkpoint,
    )

    # Write checkpoint file for injection by inject-checkpoint.py
    checkpoint_path = os.path.join(STATE_DIR, f"unimatrix-checkpoint-{session_id}.md")
    atomic_write(checkpoint_path, checkpoint)


if __name__ == "__main__":
    main()
