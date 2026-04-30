# Review Mode

Alias: comply

## When Triggered
- "Review this", "review my changes"
- Code review requests
- Explicit comply invocation

## Scope Resolution

Before dispatching, determine scope (in priority order):
1. Brain task ID provided → use task
2. --branch flag → all committed changes on branch vs main
3. File path provided → review that file
4. No arguments + uncommitted changes → review uncommitted only
5. No arguments + clean tree → review full branch vs main

## Flow

### Tier Selection

Per Protocol C § C5a: classify triviality of the scope before dispatching.
- **TRIVIAL** verdict → Single Sentinel (default path).
- **NON_TRIVIAL** verdict → Compliance Matrix Review (Borg sphere).
- `--matrix` flag forces NON_TRIVIAL path regardless of classifier.
- `classifyTriviality` unavailable → default to Single Sentinel (compatibility fallback).

### Single Sentinel (TRIVIAL path)

1. Generate designation (Designation Generation Protocol, role: SENTINEL)
2. Dispatch sentinel-protocol:
   - If task ID: "sentinel — verification sequence initiated. Task: <id>"
   - If branch: "Scope: all changes on current branch vs main. Use git diff main...HEAD"
   - If uncommitted: "Scope: uncommitted changes. Use git diff + git diff --cached"
   - If file: "Scope: <path>"
3. Wait for completion
4. Present verdict

### Compliance Matrix Review (NON_TRIVIAL path)

Deploy multiple sentinels reviewing from different angles (Borg sphere).

1. Generate designations (multiple)
2. Create team: TeamCreate(team_name: "review-matrix-<scope>")
3. Spawn each sentinel with scoped prompt and team membership:
   - Include REVIEW MATRIX ACTIVE block:
     "You are part of a compliance matrix reviewing this changeset from different angles.
     - CROSS-CUTTING FINDINGS: Message teammates when findings affect their scope
     - CHALLENGE FINDINGS: Raise conflicts with other adjuncts' assessments
     - INTEGRATION RISKS: Flag problems that emerge from combining individually-correct changes
     - RESPOND TO MESSAGES: Always acknowledge teammate findings"
4. Wait for all to complete
5. Merge verdicts: any BLOCK → BLOCK, any NEEDS_CHANGES → NEEDS_CHANGES, PASS only if all PASS
6. Cleanup: shutdown team, delete team

Increment `teamReviewCount` per Protocol C § C5a per-saga budget. When cap exhausted, fall back to Single Sentinel.

## Flags
- --branch: force review of full branch vs main
- --matrix: force compliance matrix (NON_TRIVIAL path)
