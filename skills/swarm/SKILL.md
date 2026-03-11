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

1. **Spawn Queen for Planning** — Delegate to the `queen` agent with the user's request and scope. The queen will:
   - Research the codebase (dispatching a `probe` if needed)
   - Partition files into logical groups by directory, module, or feature area. Each group must be independently modifiable without conflicts. The queen decides the optimal number of partitions (hard max of 5, can be lowered by the user). If there are more natural groups than the limit, merge the smallest/most-related groups.
   - Create brain tasks: one parent task + one subtask per partition with self-contained descriptions (file list, goal, instructions). All subtasks are independent (no dependencies).
   - Return a dispatch plan with the parent task ID and partition assignments.

2. **Generate Designations** — `/designate <N> --role drone --trimatrix`

3. **Dispatch Drones** — Spawn one drone per partition as file-partitioned drones (no worktree isolation — partitions are non-overlapping by design, drones work directly on the current branch):
   ```
   Agent:
     subagent_type: "drone"
     name: "<designation>"
     description: "<designation> — <task summary>"
     run_in_background: true
     prompt: |
       You are Drone <designation> executing brain task <task-id> — "<task title>".
       FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other drones are working on other files in parallel — touching their files will cause conflicts.
   ```

4. **Monitor** — Wait for all drones to complete. Check brain task comments for blockers.

5. **Review** — Dispatch `vinculum` with the parent task ID to review aggregate changes.

6. **Handle Verdict** — On PASS: close all subtasks and the parent task. On NEEDS_CHANGES: spawn drones to fix. On BLOCK: escalate.

## Concurrency

The queen's dispatch plan determines how many drones to spawn based on the natural file partitions and task complexity. The hard maximum is **5** concurrent drones. The first argument can optionally be a number to lower this limit (e.g., `3` to cap at 3 drones). The limit can never exceed 5.

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
3. Dispatch 3 drones in parallel, each handling only its assigned files
4. Review the aggregate diff
5. Close on PASS
