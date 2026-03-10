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
- If an adjunct finds critical issues, route back to a drone with specific fix instructions

## Git Discipline
- Only the lead agent commits and pushes
- Drones in worktrees can commit to their worktree branch
- Merge strategy: lead reviews worktree branches before merging
