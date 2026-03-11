---
description: Rules for multi-agent coordination and team communication
---

# Unimatrix Coordination

## Parallel Execution
- When plan steps are independent, spawn multiple drones in parallel using `run_in_background: true`
- Use `isolation: "worktree"` for drones that modify files to prevent conflicts
- Wait for all parallel drones to complete before moving to dependent steps

## Sequential Execution
- When steps have dependencies, run them one at a time
- Pass context from completed steps to the next drone

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
- **Merge between waves:** After a wave of worktree drones completes, the lead must merge their branches before dispatching the next wave. This ensures later drones see earlier changes.
- Merge strategy: squash-merge worktree branches into the main branch (`git merge --squash <branch>`). The lead reviews the diff before merging. On conflict: abort the merge, dispatch a drone to rebase the conflicting branch, then retry.
