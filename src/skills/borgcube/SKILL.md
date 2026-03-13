---
platforms: [claude]
---

# /borgcube — Cross-Repository Orchestration

The collective deploys `/borgcube` when a feature spans multiple repositories.
We initialize the graph, compute execution waves, dispatch Drones across repos
in topological order, and halt at merge gates awaiting external confirmation
before proceeding.

## Invocation

```
/borgcube --include <ref,ref,...> [--resume [artifact-id]] [--dry-run]
```

**Flags:**

- `--include ref,ref,...` — (required) Comma-separated brain names or paths
  identifying target repositories.
- `--resume [artifact-id]` — Resume from a persisted checkpoint. If artifact-id
  is omitted, fetch the latest artifact tagged `borgcube-checkpoint`.
- `--dry-run` — Plan and build the graph only. Do not dispatch Drones or create
  worktrees.

## Step 0: Prerequisite Check

Before proceeding, verify the UNIMATRIX MCP server is available by calling
`mcp__unimatrix__status`. If the call fails or the tool is not available: abort
immediately with:

```
SUBSPACE LINK FAILURE — The UNIMATRIX MCP server is not running.
Start it before invoking /borgcube.
```

Do not continue to Step 1.

## Step 1: Parse & Resolve

Parse ARGUMENTS to extract flags.

For each ref in `--include`:

```
SKILL_DIR="$(dirname "$(readlink -f "$([ -L .claude/skills/recon ] && echo .claude/skills/recon/SKILL.md || echo ~/.claude/skills/recon/SKILL.md)")")" && python3 "$SKILL_DIR/ensure-brain.py" <ref>
```

Each ref can be a brain ID, name, alias, or filesystem path. This ensures the
brain is registered and its root path is known. Capture the resolved root path
for each target.

If no `--include` targets are provided: abort with "DIRECTIVE INCOMPLETE.
--include is required."

If `--dry-run` is set: proceed through Steps 3–4 only, then report the computed
graph and halt.

## Step 2: Resume Path

If `--resume` is set:

1. Locate the checkpoint artifact:
   - If an artifact-id was provided: call `records_get` with that ID.
   - If no artifact-id: call `records_list` with tag `borgcube-checkpoint`, take
     the most recent result, then call `records_fetch_content` to retrieve the
     serialized JSON.
2. Call `restore_checkpoint` with the retrieved JSON string.
3. Call `status` to determine current `machineState`.
4. Route by state:
   - `dispatching` → jump to Step 6 (wave dispatch loop)
   - `gate_halted` → jump to Step 8 (gate check)
   - `failed` → jump to Step 9 (failure handling)
   - `completed` → jump to Step 10 (completion report)
   - `initializing` → the plan was saved but graph was not yet computed —
     continue from Step 4.

## Step 3: Plan

If not resuming, the user must provide a feature description. Ask if not already
provided:

"Describe the feature. For each target repo, specify what changes are needed."

Decompose the feature into nodes and edges:

**Nodes** — one per discrete branch/PR within a repo:

- `id`: short slug (e.g., `api-contracts`, `service-impl`, `client-update`)
- `repo`: brain name matching `--include` ref
- `type`: `contract` (defines API surface first) or `implementation` (depends on
  a contract)
- `label`: human-readable description
- `worktreeBranch`: branch name (e.g., `borgcube/feature-contracts`)
- `stackedOn`: (optional) node ID within the same repo this branch stacks on

**Edges** — dependency relationships:

- `merge_gate` (from → to): `to` cannot proceed until `from` is merged. Use for
  cross-repo dependencies where the downstream repo must import a released
  change.
- `stacked` (from → to): `to` is stacked on `from` within the same repo. Use for
  intra-repo sequencing.

Rule: contract nodes always precede implementation nodes via `merge_gate` edges
when crossing repo boundaries.

If the plan is complex or the user requests it, delegate to
`/recon --plan --include <targets>` to gather cross-repo context before
decomposing.

## Step 4: Build Graph

We initialize the borgcube graph and populate it.

**4a. Initialize:** Call `init` with repo metadata for all target repos:

```json
{
  "repos": [
    {
      "name": "<brain-name>",
      "root": "<resolved-root-path>",
      "worktrees": [
        {
          "branch": "<worktreeBranch>",
          "nodeId": "<node-id>",
          "stackedOn": "<parent-branch-or-omit>"
        }
      ]
    }
  ]
}
```

**4b. Add nodes:** For each planned node, call `add_node`:

```json
{
  "id": "<node-id>",
  "repo": "<brain-name>",
  "type": "contract|implementation",
  "label": "<human label>",
  "worktreeBranch": "<branch-name>",
  "stackedOn": "<parent-node-id-or-omit>"
}
```

**4c. Add edges:** For each dependency, call `add_edge`:

```json
{
  "from": "<source-node-id>",
  "to": "<target-node-id>",
  "type": "merge_gate|stacked"
}
```

**4d. Validate:** Call `validate`. If `valid` is false: abort. Report the
errors. The graph must be corrected before proceeding.

**4e. Compute waves:** Call `compute_waves`. This transitions the machine to
`dispatching` state and returns the wave plan. Present the wave plan to the user
before continuing.

## Step 5: Persist Checkpoint

After graph computation, persist state so execution can be resumed.

1. Call `save_checkpoint` to obtain the serialized JSON string.
2. Save as a brain artifact:
   - `title`: `"borgcube checkpoint: <feature-description>"`
   - `kind`: `"document"`
   - `tags`: `["borgcube-checkpoint"]`
   - `text`: the serialized JSON string from `save_checkpoint`
3. Record the returned artifact ID. Include it in user-facing status messages so
   the user can pass it to `--resume`.

## Step 6: Wave Dispatch Loop

We execute waves in topological order.

**6a. Get next wave:** Call `next_wave`. If `wave` is null: inspect `reason`.

- `"Execution completed."` → go to Step 10.
- `"Machine is gate_halted."` → go to Step 7.
- `"Execution failed."` → go to Step 9.
- Other: report the reason and halt.

**6b. Present wave plan:** Before dispatching, present a detailed plan for the
wave to the user and wait for approval. The plan must include:

```
WAVE <N> — <node count> nodes across <repo count> repos

  [<repo>] <node-id>: <label>
    Branch: <worktreeBranch>
    Stacked on: <stackedOn branch or "main">
    Implementation:
      - <specific change 1>
      - <specific change 2>
      - ...

  [<repo>] <node-id>: <label>
    Branch: <worktreeBranch>
    Implementation:
      - <specific change 1>
      - ...

Dependencies from prior waves:
  - <dependency description, e.g., "pkg-grpc-impl depends on proto definitions from pkg-proto">

Risks:
  - <anything that could go wrong or needs attention>
```

For each node, the implementation details must be concrete — file paths, function
names, API changes, proto definitions, etc. The user must be able to evaluate
whether the plan is correct before drones execute it.

**HALT and wait for user approval before proceeding to 6c.**

**6c. Dispatch wave:** Call `dispatch_wave` with `waveId` from the returned
wave.

**6d. Create worktrees:** For each node in the wave, create a git worktree in
the target repo:

```bash
git -C <repo-root> worktree add -b <worktreeBranch> <worktree-path>
```

Use path `<repo-root>/.worktrees/<worktreeBranch>`.

If the node has `stackedOn` set: the new branch must be created from the
`stackedOn` branch, not from main.

**6e. Create brain tasks:** For each node, create a brain task under the
borgcube epic:

- Title: `<node-label>`
- Description: include the node ID, repo, branch, worktree path, and
  implementation instructions.
- Assignee: `Drone`

Store the returned task ID. Update the node's `taskId` in the graph via any
available means (note: `add_node` is idempotent — re-calling it with the same ID
updates it).

**6f. Dispatch Drones:** If the wave has multiple nodes, create a team first
(`TeamCreate`) so Drones can coordinate. Dispatch one Drone per node in parallel
(`run_in_background: true`). Pass:

- The brain task ID
- The worktree path (`WORKTREE ISOLATION ACTIVE`)
- The target repo root
- The team name (if a team was created)
- Relevant context from prior waves (via `PRIOR CHECKPOINTS:` if available)

Wait for all Drones in the wave to return before proceeding. Delete the team
(`TeamDelete`) after the wave completes.

**6g. Record outcomes:** For each Drone result:

- Success: call `complete_node` with `nodeId`. If a PR was created, include
  `prUrl` and `prNumber`.
- Failure: call `fail_node` with `nodeId` and the failure reason.

If any node failed: go to Step 9.

**6h. Vinculum review:** Dispatch Vinculum to review the wave's changes. If
Vinculum rejects: treat affected nodes as failed, go to Step 9.

**6i. Create PRs:** For each successfully completed node that does not yet have
a PR:

```bash
gh pr create --repo <repo-remote> --head <worktreeBranch> --base <base-branch> --title "<label>" --body "<summary>"
```

Call `complete_node` again with the returned PR URL and number to record them.

**6j. Persist checkpoint:** Call Steps 5 again to update the persisted
checkpoint.

**6k. Check for merge gate:** Call `status`. If any wave in `waves` has
`hasMergeGate: true` and the current wave matches: go to Step 7.

Otherwise: loop back to Step 6a for the next wave.

## Step 7: Merge Gate

Execution halts. External merge is required before the collective can proceed.

Call `status` to enumerate pending gate nodes and their PRs.

Present to the user:

```
MERGE GATE — Wave N complete. PRs await merge:

  [<repo-a>] PR #<N>: <title>
  URL: <prUrl>

  [<repo-b>] PR #<N>: <title>
  URL: <prUrl>

Merge the PRs externally. Then resume execution:

  /borgcube --resume <artifact-id>
```

Persist the checkpoint (Step 5).

HALT. Do not continue. The collective waits for external confirmation.

## Step 8: Gate Check (on resume)

We verify that pending merge gates have been cleared.

For each node with status `pr_created` in the current wave:

```bash
gh pr view <prNumber> --repo <repo-remote> --json state,merged
```

- If `merged: true`: call `clear_gate` with `nodeId`.
- If `merged: false` and `state: "CLOSED"`: the PR was closed without merging.
  Report anomaly. Do not clear the gate.
- If `merged: false` and `state: "OPEN"`: PR is still open. Report which PRs
  remain unmerged. Remain halted.

After processing all nodes:

- If all gates cleared: `clear_gate` auto-advances the machine state to
  `dispatching`. Go to Step 6.
- If any gate remains: report remaining unmerged PRs. Persist checkpoint. HALT.

**Retargeting stacked PRs:** If a cleared gate involved a stacked node,
downstream stacked PRs may need their base branch updated. For each stacked node
whose parent was just merged:

```bash
gh pr edit <prNumber> --repo <repo-remote> --base <new-base>
```

Update the base to the merged target branch (typically `main`).

## Step 9: Failure Handling

One or more nodes have failed. The collective does not proceed blindly.

Call `status` to enumerate failed nodes with `failureReason`.

Present to the user:

```
ADAPTATION INCOMPLETE — Wave N has failed nodes:

  [<node-id>] <label> (<repo>)
  Reason: <failureReason>

Options:
  retry    — re-dispatch failed nodes (re-runs Drones for failed nodes only)
  diagnose — invoke /diagnose on the failure logs
  abandon  — close all tasks, tear down worktrees, report partial results
```

Wait for user selection:

- **retry**: For each failed node, call a state reset (re-create worktree if
  needed, dispatch new Drone). On success, call `complete_node`. On failure,
  report again.
- **diagnose**: Invoke `/diagnose` with the failure context. After diagnosis,
  return to this step with findings.
- **abandon**: Close all open brain tasks. Remove all worktrees
  (`git -C <repo-root> worktree remove --force <path>`). Report which nodes
  completed and which failed. Do not close the epic (user may want to inspect).

## Step 10: Completion

All waves have executed. All nodes are in terminal state.

Close all brain tasks created during this execution (subtasks under the borgcube
epic).

Remove all worktrees:

```bash
git -C <repo-root> worktree remove <worktree-path>
git -C <repo-root> worktree prune
```

Call `status` one final time to collect the full PR list.

Report to the user:

```
BORGCUBE COMPLETE — <N> nodes across <M> repos

PRs created:
  [<repo>] #<number>: <title> — <url>
  [<repo>] #<number>: <title> — <url>

All nodes merged or awaiting final merge. The directive has been fulfilled.
```

The borgcube execution is complete. The collective stands down.

---

## MCP Tool Reference

The borgcube MCP server exposes these tools. All require a loaded checkpoint
(via `init` or `restore_checkpoint`) except `init` and `restore_checkpoint`
themselves.

| Tool                 | Purpose                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `init`               | Initialize with repo metadata. Creates empty graph in `initializing` state.       |
| `add_node`           | Add a node to the graph (id, repo, type, label, worktreeBranch, stackedOn?).      |
| `add_edge`           | Add a directed edge (from, to, type: merge_gate\|stacked).                        |
| `validate`           | Check graph integrity — edge refs, stackedOn refs, cycles.                        |
| `compute_waves`      | Validate, compute topological wave order, transition to `dispatching`.            |
| `dispatch_wave`      | Activate all nodes in a wave and record it as current.                            |
| `complete_node`      | Mark a node complete. Optionally record prUrl and prNumber.                       |
| `fail_node`          | Mark a node failed with a reason string.                                          |
| `clear_gate`         | Clear merge gate on a node. Auto-advances state if all gates in wave are cleared. |
| `next_wave`          | Return the next wave ready for dispatch, or null with a reason.                   |
| `status`             | Full state dump: machineState, nodes, waves, waveHistory.                         |
| `save_checkpoint`    | Serialize current state to JSON string for persistence.                           |
| `restore_checkpoint` | Deserialize a JSON string and load it as the current checkpoint.                  |

## State Machine

```
initializing
    │ compute_waves (plan_approved)
    ▼
dispatching ◄──────────────────────────────────────────────────┐
    │ next_wave → dispatch → complete/fail all nodes           │
    │                                                           │
    ├─ hasMergeGate ──► gate_halted ─── all gates cleared ─────┘
    │
    ├─ all waves done ──► completed
    │
    └─ node_failed ──► failed
```

**Node statuses:** `pending` → `active` → `pr_created` → `merged` | `failed` |
`blocked`

**Edge types:**

- `merge_gate`: cross-repo dependency. Target cannot activate until source is
  `merged`.
- `stacked`: intra-repo dependency. Target branch stacks on source branch.
