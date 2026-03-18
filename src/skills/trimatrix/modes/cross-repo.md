# Cross-Repo Mode

Alias: none

## When Triggered
- Feature spans multiple repositories
- User provides --include flag with repo refs
- Cross-repo dependencies, merge gates needed
- User explicitly uses /trimatrix cross-repo

## Invocation
/trimatrix cross-repo --include <ref,ref,...> [--resume [artifact-id | brain-ref]] [--dry-run]

## Flags
- --include ref,ref,... — Target repositories (brain names or paths). Required for fresh invocation.
- --resume [artifact-id | brain-ref] — Resume from persisted checkpoint.
- --dry-run — Plan and build graph only, no execution.

## MCP Tools
This mode uses the trimatrix MCP state machine. See CROSS-REPO.md for the complete reference.

Key tools: init, add_repo, add_node, add_edge, validate, compute_waves, dispatch_wave, complete_node,
fail_node, clear_gate, next_wave, status, save_checkpoint, restore_checkpoint, cancel, archive,
list_sessions, designate, resolve_brains.

## State Machine

```
initializing → dispatching → gate_halted → dispatching (loop)
                           → completed
             → failed → dispatching (retry)
Any non-terminal → cancelled
Any non-terminal → refining → dispatching (via compute_waves)
```

Note: Cross-repo mode does NOT use the shared worktree lifecycle protocol. It manages per-node
worktrees in target repositories, not a single orchestration worktree.

## Flow

### Step 0: Prerequisite Check

Call mcp__unimatrix__status. If fails: "SUBSPACE LINK FAILURE — The UNIMATRIX MCP server is not
running." Abort.

### Step 1: Parse & Resolve

Parse flags. Resolve all --include refs via resolve_brains. Abort on failure.

### Step 2: Resume Path (if --resume)

If reached via the unified RESUME flow (SKILL.md Path A), the graph is already loaded and new
brain/repo already attached. Skip to step 6 below.

Otherwise (direct `/trimatrix cross-repo --resume`):

1. Locate checkpoint artifact (by ID, brain-ref, or latest tagged trimatrix-checkpoint)
2. Call restore_checkpoint
3. Call status to determine machineState
4. Merge repo context (checkpoint repos + --resume ref + --include refs)
5. Refinement check: if new repos added or user provides new instructions → enter refinement mode
   (refine → add_repo/add_node/add_edge → compute_waves → approval)
6. Route by state:
   - dispatching → Step 6
   - gate_halted → Step 8
   - failed → Step 9
   - initializing → Step 4
   - completed → Step 10

### Step 3: Plan

Decompose feature into nodes (one per branch/PR per repo) and edges (merge_gate for cross-repo,
stacked for intra-repo).
- Contract nodes precede implementation nodes via merge_gate
- If complex: delegate to investigate mode with --plan --include for cross-repo context

### Step 4: Build Graph

4a. init with repo metadata
4b. add_node for each planned node
4c. add_edge for each dependency
4d. validate — abort if invalid
4e. compute_waves — transitions to dispatching, returns wave plan

### Step 4f: Session Naming Gate

Present the plan and a proposed session name (concise, lowercase, hyphenated). Elicit via `AskUserQuestion` with three options:
- **Accept** — approve plan and name. Proceed.
- **Revise** — provide feedback or different name. Re-plan if needed, re-elicit.
- **Decline** — halt and wait for further instructions.

On accept: call `rename_session` with the confirmed label, then `/rename` to sync conversation title.

### Step 5: Persist Checkpoint

save_checkpoint → save as brain artifact tagged:
- trimatrix-checkpoint
- trimatrix-repo:<name> (one tag per repo)
- trimatrix-session:<sessionId>

### Step 6: Wave Dispatch Loop

6a. next_wave — if null, check reason (completed/gate_halted/failed)
6b. Wave approval — present plan, wait for user approval
6c. dispatch_wave
6d. Create worktrees per node: <repo-root>/.claude/worktrees/<branch>
6e. Create brain tasks per node
6f. Dispatch Assimilation adjuncts (Borg cube if multi-node wave, create team)
6g. Record outcomes: complete_node or fail_node
6h. Validation adjunct review (see Review Mode for compliance matrix option)
6i. Create PRs via gh pr create
6j. Persist checkpoint (Step 5)
6k. Check for merge gate → Step 7, or loop to 6a

### Step 7: Merge Gate

Present pending PRs. Persist checkpoint. HALT. User must merge externally then:
```
/trimatrix cross-repo --resume
```

### Step 8: Gate Check (on resume)

For each pending PR: gh pr view.
- If merged: clear_gate
- If all cleared: continue dispatch (Step 6)
- If any open: remain halted

### Step 9: Failure Handling

Enumerate failed nodes. Present options:
- **retry** — re-dispatch failed nodes
- **diagnose** — invoke diagnose mode with failure context
- **abandon** — close tasks, remove worktrees

### Step 10: Completion

Close all brain tasks. Remove per-node worktrees. Report PRs created.

## Node Worktree Convention

Each node gets an isolated worktree in its target repository:

```
<repo-root>/.claude/worktrees/<worktreeBranch>
```

Where worktreeBranch follows the pattern: `trimatrix/<node-id>`.

Assimilation adjuncts receive `WORKTREE ISOLATION ACTIVE` and the worktree path. They operate
exclusively within the assigned worktree.

## Designation Protocol

Use Designation Generation Protocol for each dispatched Assimilation adjunct. Include the node ID
in the designation context so adjuncts can be tracked per-node.

## Cross-Repo Context Passing

When nodes in later waves depend on earlier merged nodes, pass relevant context via:
- Brain task description (include PR URL, merged branch, relevant interfaces)
- PRIOR CHECKPOINTS in adjunct prompt (if prior wave saved drone-checkpoint snapshots)
