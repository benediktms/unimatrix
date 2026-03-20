# Swarm Mode

## When Triggered
- Bulk refactoring, migrations, convention enforcement
- The same change applies independently to multiple file groups
- No cross-group dependencies exist

## Flags
- First positional argument: max adjunct count (default: 5, hard max: 5)
- `--scope "glob"` — explicit glob pattern to restrict file discovery

---

## Flow

### 1. Plan Partitions
Search memory (`memory_search_minimal`) for prior recon on the target area.
If file layout is unknown, dispatch a probe to enumerate candidates.

Partition files into logical groups by directory, module, or feature boundary.
Rules:
- Each group must be independently modifiable — no shared files across groups.
- Hard maximum: 5 partitions. If more exist, merge smallest groups.
- Apply `--scope` glob if provided to restrict candidates.

Create brain tasks: one parent epic, one subtask per partition.
All subtasks are independent — no dependencies set.
Each subtask description includes: Goal / Files / Instructions / Verification (per task description format).

### 2. Generate Designations
Use Designation Generation Protocol. Generate one designation per partition adjunct plus one for the sentinel.

### 3. Dispatch Borg Cube
Spawn one drone per partition. All `run_in_background: true`. No team needed — file sets are non-overlapping.

Include in every adjunct prompt:
```
FILE PARTITION ACTIVE. Only touch files listed in your task's Files section.
Other drones are running in parallel. Crossing file boundaries creates conflicts and is non-compliant.
```

### 4. Monitor
Wait for all adjuncts to notify completion. Check brain tasks for blocked states.
Blocked adjunct → assess whether the partition can be re-dispatched or must be skipped. Report to user if skipping.

### 5. Verification Gate
Use Verification Gate Protocol. Run after all adjuncts complete (or all non-blocked adjuncts complete).

### 6. Review
Dispatch one sentinel with parent epic task ID. Scope: full swarm output.

### 7. Handle Verdict
- **PASS:** Task Closure Protocol — call `close_node(nodeId)` for each completed node, then close epic via `tasks_close`. Report completion with partition summary.
- **NEEDS_CHANGES:** Identify which partitions require fixes. Spawn targeted fix adjuncts per affected partition. Re-run Verification Gate and Review.
- **BLOCK:** Escalate to user verbatim. Do not attempt autonomous resolution.
