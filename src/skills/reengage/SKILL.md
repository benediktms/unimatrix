---
name: reengage
description: Resume execution of a previously planned brain task by dispatching Drones to ready subtasks.
---

# /reengage

Re-engage the collective on a brain task that was planned by the Queen. Use this when execution was interrupted or you want to continue a previously planned task.

## Behavior

1. Find the parent task to resume:
   - If a task ID is provided, use it
   - Otherwise, ask the user which task to resume — use `tasks_list` (status: open) to show available parent tasks and let them choose
   - **Never auto-select a task** — always confirm with the user which plan to execute
2. Use `tasks_get` with `expand: children` to load all subtasks
3. Check for stale `in_progress` subtasks from a prior crashed session. If found, present them to the user — they may need to be reset to `open` (if incomplete) or closed (if actually done). Do not auto-reset.
4. **Check for prior checkpoints** — Query `records_list` with tags `drone-checkpoint` and `parent:<task-id>` to find completed Drone snapshots from a prior session. If found, extract snapshot IDs to pass as context to the next wave's Drones via `PRIOR CHECKPOINTS:` in the prompt.
5. Use `tasks_next` to find ready (unblocked) subtasks.
6. Dispatch agents for each ready subtask based on the task's **assignee** field:
<!-- @claude -->
   - `Drone` → spawn as `subagent_type: "Drone"` with full prompt (designation, task ID, mode blocks, prior checkpoints)
   - `Probe` → spawn as `subagent_type: "Probe"` with the task ID as prompt
   - `Cortex` → spawn as `subagent_type: "Cortex"` with the task ID as prompt
<!-- @end -->
<!-- @opencode -->
   - `Drone` → spawn as `task(subagent_type="drone", description="<designation>", ...)` with full prompt (designation, task ID, mode blocks, prior checkpoints)
   - `Probe` → spawn as `task(subagent_type="probe", description="probe dispatch", ...)` with the task ID as prompt
   - `Cortex` → spawn as `task(subagent_type="cortex", description="cortex dispatch", ...)` with the task ID as prompt
<!-- @end -->
   - **Parallel waves** (independent tasks): spawn all agents with `run_in_background: true`
   - **Sequential waves** (dependent tasks): spawn one at a time, passing prior checkpoint IDs via `PRIOR CHECKPOINTS:` and recon snapshot IDs via `RECON SNAPSHOTS:` in the prompt
   - Extract snapshot IDs from each agent's completion comment for subsequent waves.
7. Monitor progress, dispatch next waves as subtasks unblock
8. When all subtasks complete, invoke **Vinculum** for review
9. Handle verdict (PASS → close all subtasks and the parent task via `tasks_close`, then call `memory_write_episode` to record what was accomplished and decisions made; NEEDS_CHANGES → fix; BLOCK → escalate)

## Usage

```
/reengage <task-id>    # Resume a specific parent task
/reengage              # List open parent tasks and ask user to choose
```
