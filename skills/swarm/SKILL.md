---
name: swarm
description: Partition files logically and dispatch parallel drones to apply changes across the codebase. Use for refactoring, migrations, bulk reviews, and convention enforcement.
---

# /swarm

Partition a codebase into logical file groups and dispatch parallel drones to apply the same type of change across all partitions simultaneously.

## When to use

- Bulk refactoring (rename a pattern, update imports, migrate an API)
- Convention enforcement (add types, fix lint, update formatting)
- Parallel code review across modules
- Any task where the same change applies independently to multiple file groups

## Behavior

1. Delegate to the `queen` agent with the user's request and scope
2. The queen assesses whether the task is clear enough to partition immediately or needs research first:

   **If the task is straightforward** (e.g., "rename X to Y", clear scope):
   - Use `probe` to discover files and partition directly

   **If the task needs research** (e.g., unclear scope, architectural questions, complex migration):
   - Dispatch an `adjunct` agent to research the codebase and produce a structured report (affected files, patterns found, recommended approach, risks)
   - Read the adjunct's report to inform partitioning

3. The queen then:
   - Partition files into logical groups by directory, module, or feature area. Each group must be independently modifiable without conflicts. The queen decides the optimal number of partitions (hard max of 5, can be lowered by the user). If there are more natural groups than the limit, merge the smallest/most-related groups. Present the partition plan to the user for approval.
   - Create brain tasks: one epic + one subtask per partition with self-contained descriptions (file list, goal, instructions). All subtasks are independent (no dependencies).
   - Generate Borg designations via `python3 hooks/designate.py <N>`
   - Dispatch one drone per partition with `isolation: "worktree"` for conflict-free parallel execution
   - Monitor completion, check brain task comments for blockers
   - Dispatch `adjunct` with the epic ID to review aggregate changes
   - On PASS: merge worktree branches, close all subtasks and the epic

## Concurrency

The queen decides how many drones to spawn based on the natural file partitions and task complexity. The hard maximum is **5** concurrent drones. The first argument can optionally be a number to lower this limit (e.g., `3` to cap at 3 drones). The limit can never exceed 5.

## Usage

```
/swarm <description>                          # Queen decides drone count (max 5)
/swarm 3 <description>                        # Limit to 3 drones
/swarm <description> --scope "src/**"         # Explicit glob scope
```

## Example

```
/swarm migrate all useState hooks to useSignal --scope "src/components/**/*.tsx"
```

This would:
1. Find all .tsx files under src/components/
2. Queen partitions by subdirectory (e.g., auth/, dashboard/, shared/) -- decides 3 drones is optimal
3. Dispatch 3 drones in parallel, each handling one group in its own worktree
4. Review the aggregate diff
5. Merge on PASS
