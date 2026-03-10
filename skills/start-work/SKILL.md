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
3. Use `tasks_next` to find ready (unblocked) subtasks
4. Dispatch **drone** agents for each ready subtask (parallel if independent)
5. Monitor progress, dispatch next waves as subtasks unblock
6. When all subtasks complete, invoke **vinculum** for review
7. Handle verdict (PASS → close, NEEDS_CHANGES → fix, BLOCK → escalate)

## Usage

```
/start-work <task-id>    # Resume a specific epic
/start-work              # List open epics and ask user to choose
```
