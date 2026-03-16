# Review Mode

Alias: /comply

## When Triggered
- "Review this", "review my changes"
- Code review requests
- Explicit /comply invocation

## Scope Resolution

Before dispatching, determine scope (in priority order):
1. Brain task ID provided → use task
2. --branch flag → all committed changes on branch vs main
3. File path provided → review that file
4. No arguments + uncommitted changes → review uncommitted only
5. No arguments + clean tree → review full branch vs main

## Flow

### Single Review (default)

1. Generate designation (Designation Generation Protocol, role: Vinculum)
2. Dispatch adjunct-validation-protocol:
   - If task ID: "Validation adjunct — verification sequence initiated. Task: <id>"
   - If branch: "Scope: all changes on current branch vs main. Use git diff main...HEAD"
   - If uncommitted: "Scope: uncommitted changes. Use git diff + git diff --cached"
   - If file: "Scope: <path>"
3. Wait for completion
4. Present verdict

### Compliance Matrix Review (when --matrix flag or complex scope)

Deploy multiple Validation adjuncts reviewing from different angles.

1. Generate designations (multiple)
2. Create team: TeamCreate(team_name: "review-matrix-<scope>")
3. Spawn each Validation adjunct with scoped prompt and team membership:
   - Include REVIEW MATRIX ACTIVE block:
     "You are part of a compliance matrix reviewing this changeset from different angles.
     - CROSS-CUTTING FINDINGS: Message teammates when findings affect their scope
     - CHALLENGE FINDINGS: Raise conflicts with other adjuncts' assessments
     - INTEGRATION RISKS: Flag problems that emerge from combining individually-correct changes
     - RESPOND TO MESSAGES: Always acknowledge teammate findings"
4. Wait for all to complete
5. Merge verdicts: any BLOCK → BLOCK, any NEEDS_CHANGES → NEEDS_CHANGES, PASS only if all PASS
6. Cleanup: shutdown team, delete team

## Flags
- --branch: force review of full branch vs main
- --matrix: force compliance matrix review (multiple adjuncts)
