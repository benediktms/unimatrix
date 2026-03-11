---
name: start-work
description: Resume execution of a previously planned brain task by dispatching Drones to ready subtasks, with sequence dispatch mode support.
---

# /start-work

Re-engage the collective on a brain task that was planned by the Queen. Use this when execution was interrupted or you want to continue a previously planned task. Handles both standard and sequence dispatch mode epics.

## Behavior

1. Find the parent task to resume:
   - If a task ID is provided, use it
   - Otherwise, ask the user which task to resume — use `tasks_list` (status: open) to show available parent tasks and let them choose
   - **Never auto-select a task** — always confirm with the user which plan to execute
2. Use `tasks_get` with `expand: children` to load all subtasks
3. Check for stale `in_progress` subtasks from a prior crashed session. If found, present them to the user — they may need to be reset to `open` (if incomplete) or closed (if actually done). Do not auto-reset.
4. **Detect sequence mode** — Query `records_list` with tag `sequence:<epic-id>` to check if the epic has handoff snapshots. If snapshots exist:
   - This epic was using sequence dispatch mode
   - Inspect the snapshot tags to find the highest `step:<N>` tag — this identifies the last completed step
   - Fetch the latest handoff snapshot via `records_fetch_content` to get context for the next drone
   - When dispatching the next drone, prepend the snapshot content to its prompt as `PRIOR STEP CONTEXT:` and include the `SEQUENCE HANDOFF ACTIVE` block (see dispatch step below)
   - Continue the sequence relay pattern: dispatch one drone at a time, each saves a handoff snapshot before completing
5. **Check for prior checkpoints** — Query `records_list` with tags `drone-checkpoint` and `parent:<task-id>` to find completed Drone snapshots from a prior session. If found, extract snapshot IDs to pass as context to the next wave's Drones via `PRIOR CHECKPOINTS:` in the prompt.
6. Use `tasks_next` to find ready (unblocked) subtasks.
7. Dispatch agents for each ready subtask based on the task's **assignee** field:
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
   - **Sequence mode epics**: dispatch one drone at a time with handoff context rather than all ready subtasks in parallel. Include the following block in the drone's prompt:
     ```
     SEQUENCE HANDOFF ACTIVE. You are continuing a relay sequence. Read all PRIOR STEP CONTEXT carefully before starting. When you complete your step, save a concise handoff snapshot via records_save_snapshot with tags sequence:<epic-id>, step:<N>. The snapshot must contain: what you changed, current epic state, and what the next drone needs to continue.
     ```
   - Extract snapshot IDs from each agent's completion comment for subsequent waves.
8. Monitor progress, dispatch next waves as subtasks unblock
9. When all subtasks complete, invoke **Vinculum** for review
10. Handle verdict (PASS → close all subtasks and the parent task via `tasks_close`, then call `memory_write_episode` to record what was accomplished and decisions made; NEEDS_CHANGES → fix; BLOCK → escalate)

## Usage

```
/start-work <task-id>    # Resume a specific parent task
/start-work              # List open parent tasks and ask user to choose
```
