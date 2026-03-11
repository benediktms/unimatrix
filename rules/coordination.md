---
description: Rules for multi-agent coordination and team communication
---

# Unimatrix Coordination

## Parallel Execution
- When plan steps are independent, spawn multiple drones in parallel using `run_in_background: true`
- **File-partitioned (swarms):** When drones have non-overlapping file lists, dispatch them directly on the main tree — no worktree isolation needed. Each drone is instructed to only touch its assigned files.
- **Worktree-isolated (sequential plans):** When parallel drones within a wave might touch overlapping files, or when later waves depend on earlier ones, use `isolation: "worktree"` to prevent conflicts.
- Wait for all parallel drones to complete before moving to dependent steps

## Sequential Execution
- When steps have dependencies, run them one at a time
- Pass context from completed steps to the next drone

## Sequence Execution (Relay)
- For long sequential chains (3+ steps), use sequence relay mode to avoid queen compaction
- Each drone saves a handoff snapshot via `records_save_snapshot` with tags `sequence:<epic-id>`, `step:<N>`
- The next drone receives only the handoff snapshot as prior context, not the full conversation history
- Drones run serially on the main tree — no worktree isolation or merge steps needed
- On drone failure: the sequence halts, queen assesses and decides whether to re-dispatch, re-plan, or escalate
- Snapshot content must be concise (under 2KB) — summary of changes, key decisions, and context for the next step
- The queen does not need to stay alive between steps for the happy path; Brain records are the communication channel

## Communication
- When using agent teams, prefer targeted `message` over `broadcast` to save tokens
- Keep inter-agent messages concise — share findings, not full file contents
- If a drone is blocked, escalate to the Queen immediately

## Error Handling
- If a drone fails, do not retry with the same approach
- Report the failure context to the Queen/user and wait for guidance
- If the vinculum finds critical issues, route back to a drone with specific fix instructions

## Git Discipline
- Drones commit their changes. Only the lead agent pushes.
- **File-partitioned drones:** Commit directly to the main branch. No merge step needed since files don't overlap.
- **Worktree drones — merge between waves:** After a wave of worktree drones completes, the lead must merge their branches before dispatching the next wave. This ensures later drones see earlier changes. Merge strategy: squash-merge worktree branches into the main branch (`git merge --squash <branch>`). The lead reviews the diff before merging. On conflict: abort the merge, dispatch a drone to rebase the conflicting branch, then retry.
- **Sequence relay drones:** Commit directly to the main branch. No merge step needed since drones run serially and each sees the previous drone's commits.
