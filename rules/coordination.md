---
description: Rules for multi-agent coordination and team communication
---

# Unimatrix Coordination

## Architecture

The **queen** plans and creates brain tasks. The **lead session** orchestrates execution by creating a team and spawning drones. Drones implement, save checkpoints, and report completion. The lead monitors progress and handles wave transitions.

## Parallel Execution
- When plan steps are independent, spawn multiple drones in parallel using `run_in_background: true`
- **File-partitioned (swarms):** When drones have non-overlapping file lists, dispatch them directly on the current branch — no worktree isolation needed. Each drone is instructed to only touch its assigned files.
- **Worktree-isolated:** When parallel drones within a wave might touch overlapping files, use `isolation: "worktree"` to prevent conflicts.
- Wait for all parallel drones to complete before moving to dependent steps

## Sequential Execution
- When steps have dependencies, run them one at a time
- Pass prior checkpoint IDs from completed drones to the next drone's prompt

## Mixed-Mode Execution
- Plans are often mixed — some waves parallel, others sequential
- A typical pattern: parallel foundation → sequential integration → parallel finishing
- The queen's dispatch plan specifies the wave structure; the lead follows it

## Drone Checkpoints
- Every drone saves a completion checkpoint via `records_save_snapshot` (tagged `drone-checkpoint`, `parent:<parent-task-id>`)
- The snapshot ID is included in the drone's completion comment on the brain task
- The lead extracts snapshot IDs and passes them to subsequent drones via `PRIOR CHECKPOINTS:` in the prompt
- This enables context flow between waves without the lead needing to relay full content

## Communication
- When using agent teams, prefer targeted `message` over `broadcast` to save tokens
- Keep inter-agent messages concise — share findings, not full file contents
- If a drone is blocked, escalate to the lead immediately

## Error Handling
- If a drone fails, do not retry with the same approach
- Report the failure context to the user and wait for guidance
- If the vinculum finds critical issues, spawn new drones with specific fix instructions

## Git Discipline
- Drones commit their changes. Only the lead agent pushes.
- **File-partitioned drones:** Commit directly to the current branch. No merge step needed since files don't overlap.
- **Worktree drones — merge between waves:** After a wave of worktree drones completes, the lead must merge their branches before dispatching the next wave. Merge strategy: squash-merge worktree branches (`git merge --squash <branch>`). The lead reviews the diff before merging. On conflict: abort the merge, dispatch a drone to rebase the conflicting branch, then retry.
- **Sequential drones:** Commit directly to the current branch. No merge step needed since drones run serially.
