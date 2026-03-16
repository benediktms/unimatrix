---
name: swarm
description: Partition files logically and dispatch parallel Assimilation adjuncts to apply changes across the codebase. Use for refactoring, migrations, bulk reviews, and convention enforcement.
---

# /swarm

Partition a codebase into logical file groups and dispatch parallel Assimilation adjuncts to apply the same type of change across all partitions simultaneously.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## When to use

- Bulk refactoring (rename a pattern, update imports, migrate an API)
- Convention enforcement (add types, fix lint, update formatting)
- Parallel code review across modules
- Any task where the same change applies independently to multiple file groups

## Behavior

1. **Plan the partitions** — You ARE the planning agent. Research the codebase (dispatching a `Reconnaissance` adjunct if needed) and:
   - Partition files into logical groups by directory, module, or feature area. Each group must be independently modifiable without conflicts. Decide the optimal number of partitions (hard max of 5, can be lowered by the user). If there are more natural groups than the limit, merge the smallest/most-related groups.
   - Create brain tasks: one parent task + one subtask per partition with self-contained descriptions (file list, goal, instructions). All subtasks are independent (no dependencies).
   - Produce the dispatch plan with the parent task ID and partition assignments.

2. **Generate Designations** — `/designate <N> --role Assimilation --trimatrix`

3. **Dispatch Assimilation adjuncts** — Spawn one Assimilation adjunct per partition as file-partitioned adjuncts (no worktree isolation — partitions are non-overlapping by design, adjuncts work directly on the current branch):
<!-- @claude -->
   ```
   Agent:
     subagent_type: "adjunct-assimilation-protocol"
     name: "<designation>"
     description: "<designation> — <task summary>"
     run_in_background: true
     prompt: |
       You are Assimilation adjunct <designation> executing brain task <task-id> — "<task title>".
       FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other Assimilation adjuncts are working on other files in parallel — touching their files will cause conflicts.
   ```
<!-- @end -->
<!-- @opencode -->
   ```
   task(
     subagent_type="adjunct-assimilation-protocol",
     description="<designation> — <task summary>",
     run_in_background=true,
     prompt="""
You are Assimilation adjunct <designation> executing brain task <task-id> — \"<task title>\".
FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other Assimilation adjuncts are working on other files in parallel — touching their files will cause conflicts.
"""
   )
   ```
<!-- @end -->

4. **Monitor** — Wait for all Assimilation adjuncts to complete. Check brain task comments for blockers.

5. **Verification Gate** — Run tests, lint, and formatting globally for the affected codebase. Assimilation adjuncts only verify their own changed files — this step catches cross-cutting failures.
   - If all pass, proceed to step 6.
   - If failures exist, create a brain task under the parent with the raw error output, save the failures as an artifact (`records_create_artifact`, kind `"verification-failures"`), and dispatch a single fix Assimilation adjunct for all test, lint, and formatting failures. Re-run after the fix. Max 2 fix cycles — escalate to the user if still failing.

6. **Review** — Dispatch `Validation` adjunct with the parent task ID to review aggregate changes.

7. **Handle Verdict** — On PASS: close all subtasks and the parent task. On NEEDS_CHANGES: spawn Assimilation adjuncts to fix. On BLOCK: escalate.

## Concurrency

The dispatch plan determines how many Assimilation adjuncts to spawn based on the natural file partitions and task complexity. The hard maximum is **5** concurrent Assimilation adjuncts. The first argument can optionally be a number to lower this limit (e.g., `3` to cap at 3 adjuncts). The limit can never exceed 5.

## Usage

```
/swarm <description>                          # Planner decides adjunct count (max 5)
/swarm 3 <description>                        # Limit to 3 adjuncts
/swarm <description> --scope "src/**"         # Explicit glob scope
```

## Example

```
/swarm migrate all useState hooks to useSignal --scope "src/components/**/*.tsx"
```

This would:
1. Find all .tsx files under src/components/
2. Planner partitions by subdirectory (e.g., auth/, dashboard/, shared/) -- decides 3 Assimilation adjuncts is optimal
3. Dispatch 3 Assimilation adjuncts in parallel, each handling only its assigned files
4. Review the aggregate diff
5. Close on PASS
