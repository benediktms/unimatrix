---
description: Rules for multi-agent coordination and team communication
---

# Unimatrix Coordination

## Architecture

The **Queen** plans, creates brain tasks, and orchestrates execution by creating a worktree and spawning Drones inside the worktree. Drones implement, save checkpoints, and report completion. The Queen monitors progress, handles wave transitions, and manages the worktree merge on completion.

## Orchestration Worktree
- Every `/assemble` and `/reengage` execution creates (or re-enters) an isolated worktree.
- The dispatch plan specifies the worktree branch name in its `Worktree` section.
- The worktree is created **after** the plan is approved, **before** any Drones are dispatched.
- After worktree creation, the Queen runs `brain link <brain-name>` from inside the worktree to register it as an additional root of the brain. This enables agents spawned in the worktree to access brain tasks and records.
- All Drone commits land on the worktree branch. The main branch remains clean until merge.
- On completion (Vinculum PASS + task closure), the Queen offers merge/keep/discard to the user.
- On merge: squash-merge the worktree branch, remove worktree and branch.
- `/reengage` checks whether the worktree still exists — re-enters it if so, creates it if not.

## Parallel Execution
- When plan steps are independent, spawn multiple Drones in parallel using `run_in_background: true`
- **File-partitioned (swarms):** When Drones have non-overlapping file lists, dispatch them directly on the current branch — no worktree isolation needed. Each Drone is instructed to only touch its assigned files.
- **Worktree-isolated:** When parallel Drones within a wave might touch overlapping files, use `isolation: "worktree"` to prevent conflicts.
- Wait for all parallel Drones to complete before moving to dependent steps

## Sequential Execution
- When steps have dependencies, run them one at a time
- Pass prior checkpoint IDs from completed Drones to the next Drone's prompt

## Sequence Execution (Relay)
- For long sequential chains (3+ steps), use sequence relay mode to avoid context compaction
- Each drone saves a handoff snapshot via `records_save_snapshot` with tags `sequence:<epic-id>`, `step:<N>`
- The next drone receives only the handoff snapshot as prior context, not the full conversation history
- Drones run serially on the worktree branch — no per-drone isolation or merge steps needed
- On drone failure: the sequence halts, the Queen assesses and decides whether to re-dispatch, re-plan, or escalate
- Snapshot content must be concise (under 2KB) — summary of changes, key decisions, and context for the next step
- The Queen does not need to stay alive between steps for the happy path; Brain records are the communication channel

## Mixed-Mode Execution
- Plans are often mixed — some waves parallel, others sequential
- A typical pattern: parallel foundation → sequential integration → parallel finishing
- The dispatch plan specifies the wave structure

## Drone Checkpoints
- Every Drone saves a completion checkpoint via `records_save_snapshot` (tagged `drone-checkpoint`, `parent:<parent-task-id>`)
- The snapshot ID is included in the Drone's completion comment on the brain task
- The Queen extracts snapshot IDs and passes them to subsequent Drones via `PRIOR CHECKPOINTS:` in the prompt
- This enables context flow between waves without the Queen needing to relay full content

## Communication
- **Agent teams are REQUIRED for `/recon` and `/diagnose`.** These skills depend on inter-agent communication — without a team, their protocols are non-functional. Teams are also required for collaborative waves in `/assemble`. Swarm waves in `/assemble`, `/swarm`, and `/scan` use plain subagents — no team needed.
- When using agent teams, prefer targeted `message` over `broadcast` to save tokens
- Keep inter-agent messages concise — share findings, not full file contents
- If a Drone is blocked, escalate to the Queen immediately

## Task Closure

Ownership is explicit. No task is left in a non-terminal state.

- **Drones close their own tasks.** Every Drone calls `tasks_close` as its final action. A Drone that returns without closing its task is non-compliant.
- **The Queen verifies after each wave.** After all Drones in a wave return, the Queen runs `tasks_list` filtered by the epic to confirm all wave subtasks are closed. Any orphaned task is closed by the Queen with a comment noting the Drone's failure to self-close.
- **The Queen closes the epic last.** After Vinculum PASS and all subtasks are verified closed, the Queen closes the epic. An epic with open subtasks must never be closed.
- **Failed or blocked tasks** are marked `blocked` (not left `in_progress`). The Queen decides whether to re-dispatch, cancel, or re-plan.
- **Cancelled tasks** are closed with status `cancelled` and a comment explaining why. They are not left open.

## Error Handling
- If a Drone fails, do not retry with the same approach
- Report the failure context to the user and wait for guidance
- If the Vinculum finds critical issues, spawn new Drones with specific fix instructions

## Git Discipline
- All Drone work happens on the orchestration worktree branch. Only the Queen agent pushes.
- **File-partitioned Drones:** Commit directly to the worktree branch. No merge step needed since files don't overlap.
- **Per-drone worktree isolation (overlapping files):** Each Drone gets its own nested worktree branching from the orchestration worktree branch. After the wave, the Queen squash-merges per-drone branches back to the orchestration worktree branch. On conflict: abort the merge, dispatch a Drone to rebase, then retry.
- **Sequential Drones:** Commit directly to the worktree branch. No merge step needed since Drones run serially.
- **Sequence relay Drones:** Commit directly to the worktree branch. No merge step needed since Drones run serially and each sees the previous Drone's commits.
- **Final merge:** After Vinculum PASS and task closure, the Queen squash-merges the worktree branch back to the main branch (with user approval), then removes the worktree and branch.
