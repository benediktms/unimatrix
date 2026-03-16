---
name: reengage
description: Resume execution of a previously planned brain task by dispatching Drones to ready subtasks.
---

# /reengage

Re-engage the collective on a previously planned brain task. Use this when execution was interrupted or you want to continue a previously planned task.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Behavior

1. Find the parent task to resume:
   - If a task ID is provided, use it
   - Otherwise, ask the user which task to resume — use `tasks_list` (status: open) to show available parent tasks and let them choose
   - **Never auto-select a task** — always confirm with the user which plan to execute
2. Use `tasks_get` with `expand: children` to load all subtasks
3. **Load operational intelligence** — Fetch the dispatch brief for the epic (`records_list` with tags `dispatch-brief` and `epic:<epic-id>`, then `records_fetch_content`). The dispatch brief contains all operational context — wave structure, file assignments, recon intelligence, architectural decisions. **Do not re-read files or re-search the codebase. The brief is authoritative. Dispatch immediately from it.** If no dispatch brief exists, fall back to the plan artifact (`records_list` with tag `queen-plan` and the epic's task ID).
   **Enter worktree** — The dispatch brief (or plan artifact) specifies the worktree branch name.
   - Check if the worktree exists: `git worktree list` and look for the branch name.
<!-- @claude -->
   - **If it exists:** enter it via `EnterWorktree` with the existing worktree name.
   - **If it does not exist:** create it via `EnterWorktree` with the branch name from the plan. This handles cases where the worktree was cleaned up or the session is resuming on a different machine.
<!-- @end -->
<!-- @opencode -->
   - **If it exists:** `cd` into the existing worktree directory.
   - **If it does not exist:** create it via `mkdir -p .claude/worktrees && git worktree add .claude/worktrees/<branch-name> -b <branch-name>` and `cd` into it. This handles cases where the worktree was cleaned up or the session is resuming on a different machine.
<!-- @end -->
   - All subsequent dispatch, verification, and review happens inside this worktree.
   - **If the worktree was newly created**, link it to the brain via `mcp__unimatrix__brain_link` with `name` set to the brain name (from the parent repo's `.brain/brain.toml` or the epic's brain) and `cwd` set to the worktree directory. Skip this if re-entering an existing worktree — it is already linked.
4. Check for stale `in_progress` subtasks from a prior crashed session. If found, present them to the user — they may need to be reset to `open` (if incomplete) or closed (if actually done). Do not auto-reset.
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
   - Extract snapshot IDs from each agent's completion comment for subsequent waves.
8. Monitor progress, dispatch next waves as subtasks unblock
9. When all subtasks complete, invoke **Vinculum** for review
10. Handle verdict (PASS → close all subtasks and the parent task via `tasks_close`, then call `memory_write_episode` to record what was accomplished and decisions made; NEEDS_CHANGES → fix; BLOCK → escalate)
11. **Worktree merge** — After PASS, follow the same merge flow as `/assemble` Step 9b: exit worktree, present changes, ask user to merge/keep/discard, clean up worktree on merge.

## Usage

```
/reengage <task-id>    # Resume a specific parent task
/reengage              # List open parent tasks and ask user to choose
```
