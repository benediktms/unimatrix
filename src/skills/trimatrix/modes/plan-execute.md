# Plan-Execute Mode

Aliases: assemble, reengage

## When Triggered
- Complex multi-file tasks requiring decomposition
- Tasks needing isolated worktree execution
- User explicitly uses assemble or trimatrix plan
- RESUME classification routes here when the original mode was plan-execute

---

## Entry Paths

### Fresh Entry (from assemble or classifier)
Full flow starting at Step 1.

### Resume Entry (from reengage or RESUME classification)

Two entry variants exist depending on the RESUME path taken by the classifier (see SKILL.md).

#### Variant A: Active Graph Resume (Path A routed here)
The graph is already loaded (in-memory or restored from checkpoint). New brain/repo already attached if provided. User has already confirmed intent via SKILL.md Resume Assessment Step.

1. Call `mcp__unimatrix__status` — confirm machineState and current wave. Present assessment summary (completed/pending/failed nodes, wave progress, PRs created).
2. Load epic task via `tasks_get` with `expand: children` (epic ID from graph's node metadata).
3. Check for existing worktree — `git worktree list`
   - Exists: enter via EnterWorktree
   - Does not exist: create via EnterWorktree, link brain
4. Call `mcp__unimatrix__next_wave` to find the next ready wave. Skip to Step 5.

#### Variant B: Task-Based Resume (Path B routed here)
User has already confirmed intent via SKILL.md Resume Assessment Step (if checkpoint was restored).

1. Load task via `tasks_get` with `expand: children`
2. Load dispatch brief — `records_list` with tags `dispatch-brief` + `epic:<id>`, then `records_fetch_content`
3. Check for trimatrix checkpoint — call `mcp__unimatrix__status`:
   - If not "idle" (checkpoint loaded): present assessment summary (completed/pending/failed nodes, wave progress). Use the graph's wave state to determine resume point. Call `mcp__unimatrix__next_wave` to find the next ready wave. Skip to Step 5 with graph-driven dispatch.
   - If "idle" (no checkpoint): continue to step 4.
4. Check for existing worktree — `git worktree list`
   - Exists: enter via EnterWorktree
   - Does not exist: create via EnterWorktree, link brain
5. Check for stale `in_progress` subtasks — present to user (may need reset or close)
6. Check for prior drone checkpoints — `records_list` with tags `drone-checkpoint` + `parent:<id>`
7. Use `tasks_next` to find ready subtasks
8. Jump to main flow Step 5 (Dispatch)

---

## Flow

### Step 1: Assessment
Budget: ~10 tool uses. Read the directive. Search memory (`memory_search_minimal`). Scan key files.
Determine whether recon is required.

Verdict:
- `SKIP_RECON` — sufficient context from memory and targeted reads → Step 3
- `RECON_NEEDED` — unfamiliar code areas, cross-cutting concerns → Step 2

### Step 2: Recon Phase (conditional)
Default: scan pattern — independent subagents, no team needed.
Upgrade to recon pattern if questions are cross-cutting and findings affect each other.

2a. Scope recon questions. Each question targets a specific code area or architectural concern.
2b. Use Designation Generation Protocol. Dispatch Reconnaissance or TacticalAnalysis adjuncts.
2c. Collect intelligence from completion snapshots (`records_fetch_content` on snapshot IDs from task comments).

### Step 3: Implementation Planning
Use assessment context and recon intelligence.
Proceed through Plan Materialization Protocol:
- Decompose into discrete ordered steps. Each independently executable by one Assimilation adjunct.
- Identify exact files, functions, and line ranges per step.
- Order by dependency. No step may depend on a later step.
- Create epic + subtasks + dependencies (`tasks_deps_batch`).
- Save plan artifact (kind: `plan`, tags: `["queen-plan"]`).
- Save dispatch brief (kind: `dispatch-brief`, tags: `["dispatch-brief", "epic:<id>"]`).
- Choose dispatch mode per wave: `sequential` / `sequence` / `swarm` / `collaborative`.
- Choose review strategy: `single` / `compliance matrix` (sphere).

Produce structured Dispatch Plan.

### Step 3a: Build Execution Graph

After materializing brain tasks, construct a trimatrix graph for algorithmic wave computation:

1. `mcp__unimatrix__init` with empty repos (`repos: []` for single-repo mode).
2. For each subtask, `mcp__unimatrix__add_node`:
   - `id`: the brain task ID (links graph node to brain task)
   - `type`: based on assignee — `IMPLEMENTATION` for Assimilation, `RECON` for Reconnaissance, `VALIDATION` for Validation, `DOCUMENTATION` for Closure
   - `label`: task title
   - `tags`: optional classification (wave dispatch mode, feature area)
   - Omit `repo` and `worktreeBranch` (single-repo mode)
3. For dependencies between tasks:
   - Sequential steps: `mcp__unimatrix__add_edge` with `type: DEPENDS_ON`
   - Independent steps: no edge (land in the same wave automatically)
4. `mcp__unimatrix__compute_waves` — validates the graph (detects cycles) and computes optimal wave ordering.

The computed waves replace manual wave structuring. The graph engine determines parallelism algorithmically.

### Step 3b: Plan Approval and Session Naming Gate
Present the dispatch plan and a proposed session name (concise, lowercase, hyphenated — e.g., "auth-middleware-refactor"). Elicit via `AskUserQuestion` with three options:
- **Accept** — user approves the plan and session name. Proceed.
- **Revise** — user provides feedback or a different name. Incorporate, re-plan if needed, re-elicit.
- **Decline** — halt and wait for further instructions.

On accept: call `mcp__unimatrix__rename_session` with the confirmed label, then `/rename` to sync the conversation title. Finally, `mcp__unimatrix__save_checkpoint` to persist the named graph. This is the first checkpoint — required for session resumption.

### Step 3c: Enter Worktree
Use Worktree Lifecycle Protocol. Branch name sourced from dispatch plan.

### Step 4: Generate Designations
Use Designation Generation Protocol. Generate designations for all adjuncts across all waves and the validation adjunct. Record in dispatch brief or working memory.

### Step 5: Dispatch Adjuncts

Use the graph engine for wave progression:

1. Call `mcp__unimatrix__next_wave` to get the next ready wave.
2. Call `mcp__unimatrix__dispatch_wave` with the wave ID to activate its nodes.
3. For each node in the wave, spawn the corresponding adjunct (matching node ID to brain task).

**Mode blocks by wave type:**

Swarm wave — include in each adjunct prompt:
```
FILE PARTITION ACTIVE. Only touch files listed in your task's Files section.
Other assimilation adjuncts are running in parallel. Crossing file boundaries creates conflicts.
```

Collaborative wave — include in each adjunct prompt:
```
COLLABORATIVE MODE ACTIVE. Only edit files assigned to you.
Communicate findings to teammates via team messages before modifying shared interfaces.
If another adjunct's changes affect your work, request their completion snapshot before proceeding.
Agent Communication Protocol is active. Broadcast blockers immediately.
```

Sequential / Sequence relay — no special mode block. For sequence relay, append prior handoff snapshot content to each adjunct prompt under `PRIOR STEP CONTEXT:`.

**Prior checkpoints:** After each wave completes, extract snapshot IDs from adjunct completion comments. Pass to next wave adjuncts via `PRIOR CHECKPOINTS: <ids>` in prompt.

**Spawning rules:**
- Swarm: `run_in_background: true`
- Collaborative: TeamCreate first, then `run_in_background: true` with `team_name`
- Sequential: one at a time, wait for completion
- Sequence relay: one at a time, handoff snapshots between steps

### Step 6: Monitor
Adjuncts notify on completion. Read task comments. Handle blocked tasks:
- Blocked adjunct → assess root cause → either re-dispatch with clarification or escalate to user.
- Do not retry with identical prompt.

After all adjuncts in a wave complete:
- For each successful adjunct: `mcp__unimatrix__complete_node` with the node ID (no PR info for single-repo → status becomes DONE)
- For each failed adjunct: `mcp__unimatrix__fail_node` with the node ID and failure reason
- `mcp__unimatrix__save_checkpoint` to persist state
- Loop back to `next_wave` for the next wave. If null → all waves complete, proceed to Verification Gate.

### Step 7: Verification Gate
Use Verification Gate Protocol. Run after all adjuncts in a wave complete.

### Step 8: Review
Check dispatch plan Review Strategy:

**Single:**
Dispatch one Validation adjunct. Prompt:
```
Review the implementation against the original directive and verify correctness.
Epic task ID: <id>. Worktree branch: <branch>.
Produce verdict: PASS / NEEDS_CHANGES / BLOCK.
```

**Compliance matrix (sphere):**
Deploy multiple Validation adjuncts via team. Scope each to a domain:
```
Validation adjunct <designation>: Review <domain> compliance only.
Epic task ID: <id>. Focus: <correctness | types | tests | conventions>.
Produce verdict: PASS / NEEDS_CHANGES / BLOCK with findings.
Coordinate with teammates — if another adjunct finds a blocking issue, acknowledge it.
```
Aggregate verdicts. Any BLOCK → treat whole review as BLOCK. Any NEEDS_CHANGES → treat as NEEDS_CHANGES unless all others PASS.

### Step 9: Handle Verdict
- **PASS:** Task Closure Protocol (close all subtasks, then epic). Write memory episode. Call `mcp__unimatrix__save_checkpoint` to persist the final graph state. Proceed to Step 9b.
- **NEEDS_CHANGES:** Extract specific issues from validation comments. Spawn targeted fix adjuncts with issue details prepended to prompt. Re-dispatch through Step 5. Re-review via Step 8.
- **BLOCK:** Escalate to user verbatim. Do not attempt autonomous resolution.

### Step 9b: Worktree Merge
Use Worktree Lifecycle Protocol. Present three options to user:
- **merge** — squash-merge worktree branch to main, remove worktree and branch
- **keep** — leave worktree intact for further work
- **discard** — delete worktree and branch, no merge

### Step 10: Cleanup
Tear down any teams created during collaborative waves or compliance matrix reviews.
Confirm all brain tasks are in terminal state before reporting completion.
