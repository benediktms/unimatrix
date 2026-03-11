---
name: start-work
description: Resume execution of a previously planned brain epic by dispatching drones to ready subtasks.
---

# /start-work

Resume work on a brain epic that was created by the Queen. Use this when execution was interrupted or you want to continue a previously planned epic.

## Behavior

1. Find the epic to resume:
   - If a task ID is provided, use it
   - Otherwise, ask the user which epic to resume — use `tasks_list` (type: epic, status: open) to show available epics and let them choose
   - **Never auto-select an epic** — always confirm with the user which plan to execute
2. Use `tasks_get` with `expand: children` to load all subtasks
3. Check for stale `in_progress` subtasks from a prior crashed session. If found, present them to the user — they may need to be reset to `open` (if incomplete) or closed (if actually done). Do not auto-reset.
4. **Detect sequence mode** — Check if the epic has handoff snapshots by querying `records_list` with tag `sequence:<epic-id>`. If snapshots exist:
   - This epic was using sequence dispatch mode
   - Find the highest step number from the snapshot tags to determine the last completed step
   - Fetch the latest handoff snapshot via `records_fetch_content` to get context for the next drone
   - When dispatching the next drone, prepend the snapshot content to its prompt as `PRIOR STEP CONTEXT:` and include the `SEQUENCE HANDOFF ACTIVE` block
   - Continue the sequence relay pattern (one drone at a time, each saves a handoff)
5. Use `tasks_next` to find ready (unblocked) subtasks
6. Dispatch **drone** agents for each ready subtask. For sequence mode epics, dispatch one drone at a time with handoff context rather than all ready subtasks in parallel. For non-sequence epics, dispatch in parallel if independent.
7. Monitor progress, dispatch next waves as subtasks unblock
8. When all subtasks complete, invoke **vinculum** for review
9. Handle verdict (PASS → close all subtasks and the epic via `tasks_close`, then call `memory_write_episode` to record what was accomplished and decisions made; NEEDS_CHANGES → fix; BLOCK → escalate)

## Usage

```
/start-work <task-id>    # Resume a specific epic
/start-work              # List open epics and ask user to choose
```
