# Borgcube: Cross-Repository Orchestration

## Overview

Borgcube orchestrates multi-repository feature development for the collective. When a feature spans multiple repositories and requires coordinated, staged deployments — contract-first API definitions, dependent implementations, stacked PRs with merge gates — the collective deploys borgcube.

**What borgcube does:**
- Decomposes cross-repository features into nodes (branches/PRs) and edges (dependencies)
- Computes execution waves via topological sort, respecting merge gates as wave boundaries
- Dispatches parallel Drones per wave, each working in an isolated git worktree
- Halts at merge gates, awaiting external confirmation before proceeding
- Persists state via checkpoints, enabling resumption across sessions
- Supports refinement — adding repos or recomputing waves mid-execution

**When to use borgcube vs `/assemble`:**
- **`/assemble`** — Single repository, arbitrary feature complexity. Deploys workflow with Drones, Vinculum review, task closure.
- **`/borgcube`** — Multiple repositories with inter-repo dependencies, contract-first patterns, or merge gates. Orchestrates via graph topology, wave dispatch, and gate checkpoints.

---

## State Machine

All borgcube executions follow this state machine:

```mermaid
stateDiagram-v2
    [*] --> initializing: init()

    initializing --> dispatching: compute_waves()\n(plan_approved)

    dispatching --> dispatching: wave_dispatched\nnode_completed\nwave_completed

    dispatching --> gate_halted: wave_completed\n(hasMergeGate=true,\nnot final wave)

    dispatching --> completed: wave_completed\n(final wave)

    dispatching --> failed: wave_failed\nOR node_failed

    gate_halted --> dispatching: clear_gate()\n(all gates cleared)

    gate_halted --> failed: user triage\n(abandon)

    failed --> dispatching: retry_wave()

    failed --> [*]

    completed --> [*]
```

**State descriptions:**
- **`initializing`** — Graph created, no waves computed yet. User must approve the plan before proceeding.
- **`dispatching`** — Waves are executing. Drones are active or completed. Machine loops through `next_wave()`, dispatches, monitors nodes.
- **`gate_halted`** — A wave with `hasMergeGate: true` completed. External PRs must be merged before proceeding. Machine waits for `clear_gate()` events.
- **`failed`** — One or more nodes failed. User chooses: retry failed nodes, invoke `/diagnose`, or abandon.
- **`completed`** — All waves executed, all nodes in terminal state. Clean up worktrees and report results.

---

## Dispatch Loop

The wave execution loop drives progress through the topological graph:

```mermaid
flowchart TD
    Start([Get Next Wave]) --> HasWave{next_wave returned?}

    HasWave -->|null: reason| CheckReason{Reason type?}
    CheckReason -->|gate_halted| GateHalt[MERGE GATE - wait for PRs]
    CheckReason -->|completed| Done[Execution Done - Clean up]
    CheckReason -->|failed| FailHand[FAILURE HANDLING - User triage]

    HasWave -->|wave object| PresentPlan[Present Wave Plan - wait user approval]
    PresentPlan --> UserApproves{Approved?}
    UserApproves -->|No| AbortWave[Abandon Wave]
    UserApproves -->|Yes| DispatchWave[dispatch_wave - Create worktrees + tasks]

    DispatchWave --> SpawnDrones[Spawn parallel Drones]
    SpawnDrones --> MonitorDrones[Monitor completion - wait all Drones]

    MonitorDrones --> CheckOutcome{Wave outcome?}

    CheckOutcome -->|all succeeded| VinculumReview[Dispatch Vinculum - review wave]
    CheckOutcome -->|failures| FailHand

    VinculumReview --> VinCheck{Vinculum approves?}
    VinCheck -->|Pass| RecordPRs[Create PRs - record prUrl/prNumber]
    VinCheck -->|Fail| FailHand

    RecordPRs --> PersistCP[Persist checkpoint]
    PersistCP --> CheckGate{Wave has merge_gate?}
    CheckGate -->|Yes| GateHalt
    CheckGate -->|No| Start

    GateHalt --> LoopGate[Persist - Halt - Wait user resume]
    FailHand --> FailChoice{User action?}
    FailChoice -->|retry| MonitorDrones
    FailChoice -->|diagnose| Diagnose[Invoke /diagnose]
    FailChoice -->|abandon| Done

    Done --> [*]
    LoopGate --> [*]
    AbortWave --> [*]
    Diagnose --> FailHand
```

**Key decision points:**
- **Wave approval** — User reviews implementation details before Drones execute.
- **Vinculum review** — After all nodes in wave complete, Vinculum validates changes for compliance.
- **Merge gate** — If the completed wave carries `hasMergeGate: true` and is not the final wave, execution halts.
- **Failure triage** — User chooses to retry, diagnose, or abandon.

---

## Elicitation Interaction Diagram

Borgcube integrates with the collective's elicitation capability. Three primary interaction flows exist:

```mermaid
sequenceDiagram
    participant Lead
    participant Server as UNIMATRIX Server
    participant User

    rect rgb(100, 150, 200)
        Note over Lead,User: Wave Approval Flow
        Lead->>Server: next_wave()
        Server-->>Lead: Wave object
        Lead->>User: Present wave plan, elicit approval
        alt User has elicitation
            User->>Lead: Form submission (approved/rejected)
        else User lacks elicitation
            Lead->>User: Fallback prompt, wait text response
        end
        Lead->>Lead: Parse user decision
        alt Approved
            Lead->>Server: dispatch_wave()
        else Rejected
            Lead->>Server: Abort (no state change)
        end
    end

    rect rgb(150, 200, 150)
        Note over Lead,User: Failure Triage Flow
        Lead->>Server: status()
        Server-->>Lead: Enumerate failed nodes
        Lead->>User: Present failures, elicit triage
        alt User has elicitation
            User->>Lead: Form submission (choice)
        else User lacks elicitation
            Lead->>User: Fallback prompt, wait text response
        end
        Lead->>Lead: Parse user choice
        alt retry
            Lead->>Server: dispatch_wave(waveId)
        else diagnose
            Lead->>Lead: Invoke /diagnose
        else abandon
            Lead->>Server: Mark tasks done, remove worktrees
        end
    end

    rect rgb(200, 150, 150)
        Note over Lead,User: Refinement Approval Flow
        Lead->>Lead: Detect new repos via --resume --include
        Lead->>User: Present graph + plan, elicit modifications
        alt User has elicitation
            User->>Lead: Form submission (graph updates)
        else User lacks elicitation
            Lead->>User: Fallback text interface, wait directive
        end
        Lead->>Lead: Apply graph mutations
        Lead->>Server: validate() + compute_waves()
        Lead->>Server: save_checkpoint()
        Lead->>User: Present updated wave plan, elicit approval
        alt Approved
            Lead->>Server: dispatch_wave()
        end
    end

    Note over Lead: Graceful degradation: if client has no elicitation capability, fallback to text prompts.
```

**Three flows:**
1. **Wave approval** — Drones standby until user approves implementation plan.
2. **Failure triage** — On failed nodes, user selects action: retry, diagnose, or abandon.
3. **Refinement approval** — When repos are added mid-execution, user reviews graph changes before re-dispatch.

**Graceful degradation:**
- If the client lacks elicitation capability (form-based UI), fall back to text prompts.
- The Lead parses user intent from text response and proceeds.

---

## Graph Topology

Borgcube's execution model is a directed acyclic graph (DAG) of nodes and edges.

### Node Types

**Nodes** represent discrete units of work — one branch/PR per repository:

```typescript
interface Node {
  id: string                           // "api-contracts", "service-impl", etc.
  repo: string                         // Brain name: "api", "service", etc.
  type: "contract" | "implementation"  // Contract defines API; implementation depends on it
  label: string                        // Human description
  worktreeBranch: string              // Git branch: "borgcube/api-contracts"
  stackedOn?: string                  // Node ID this node stacks on (same repo only)
  status: "pending" | "active" | "pr_created" | "merged" | "blocked" | "failed"
}
```

**Status lifecycle:**
- `pending` → `active` (node dispatched to Drone)
- `active` → `pr_created` (Drone completes, PR created)
- `pr_created` → `merged` (PR merged externally)
- `failed` (Drone reports failure)
- `blocked` (merge gate: waiting for upstream PR merge)

### Edge Types

**Edges** express dependencies between nodes:

```typescript
interface Edge {
  from: string        // Source node ID
  to: string          // Target node ID
  type: "merge_gate" | "stacked"
}
```

**`merge_gate` edges** (cross-repo dependencies):
- Target cannot activate until source is `merged`.
- Creates wave boundary — target belongs to a later wave.
- Use when downstream repo depends on released API from upstream repo.
- Example: `api-contracts` → `service-impl` (service depends on API contract).

**`stacked` edges** (intra-repo sequencing):
- Target branch stacks on top of source branch within the same repo.
- Does NOT create wave boundary — both nodes can be in the same wave.
- Target node's worktree is created from source node's branch, not main.
- Use for sequential changes within one repo.
- Example: `service-impl` → `service-tests` (tests stack on implementation).

### Example Topology

```
Two repositories: api, service.
Feature: Introduce gRPC API.

Nodes:
  contract-defs    [api]           (contract type)
  service-impl     [service]       (implementation type, depends on contract)
  service-tests    [service]       (implementation type, stacks on service-impl)

Edges:
  contract-defs --[merge_gate]--> service-impl   (service waits for API to merge)
  service-impl  --[stacked]-----> service-tests  (tests stack on impl within service)

Waves:
  Wave 1: contract-defs
           hasMergeGate: true (gates service-impl)
  Wave 2: service-impl, service-tests (parallel, both wait for contract-defs to merge)
```

**Wave computation:**
- Assigns topological levels using Kahn's algorithm.
- `merge_gate` edges advance wave level; `stacked` edges do not.
- Nodes at each level form a wave.
- Waves can execute in parallel within themselves; waves execute sequentially across.

---

## Refinement Flow

Borgcube supports **refinement** — adding repositories or modifying the graph mid-execution while preserving completed work.

### When Refinement Triggers

Refinement activates when:
1. **User calls `--resume --include <new-repos>`** — New repos added to checkpoint.
2. **User provides additional instructions on resume** — Scope change requested.
3. **User modifies graph explicitly** — Nodes/edges adjusted in refinement mode.

### State Transitions

```
dispatching or gate_halted or failed
    ↓
[Detect new repos or user instruction]
    ↓
refining ← User reviews current graph, applies changes
    ↓
[Validate + compute_waves]
    ↓
dispatching → Continue wave dispatch (or gate_halted if wave has merge gate)
```

### Invariants

- **Completed work is immutable** — Nodes in terminal state (`merged`, `failed`) cannot be modified.
- **New nodes can depend on completed nodes** — Edges from new nodes to completed nodes are allowed.
- **Partial wave recomputation** — Waves that have completed are preserved; remaining topology is recomputed.

### Refinement Example

```
Initial checkpoint:
  Wave 1: api-contracts         → completed
  Wave 2: service-impl          → active (in progress)

User calls: /borgcube --resume --include mobile-client

Refinement:
  1. Detect mobile-client not in checkpoint.repos
  2. Present current graph: highlight api-contracts (done), service-impl (active)
  3. Add new node: client-impl [mobile-client]
  4. Add edge: api-contracts --[merge_gate]--> client-impl
  5. Recompute waves:
     Wave 1: api-contracts       (preserved, completed)
     Wave 2: service-impl        (preserved, active)
     Wave 3: client-impl         (new, depends on api-contracts)
  6. Present updated plan
  7. After user approval, resume dispatch at Wave 2
```

---

## Checkpoint Lifecycle

Borgcube persists state via checkpoints. Checkpoints are saved as brain artifacts and can be resumed across sessions.

### Checkpoint Structure

```typescript
interface Checkpoint {
  version: string              // e.g., "1.0.0"
  machineState: MachineState   // current state
  graph: Graph                 // nodes and edges
  waves: Wave[]                // computed topological waves
  currentWaveId: number | null // active wave ID
  repos: RepoMetadata[]        // target repositories
  waveHistory: WaveResult[]    // completed/failed wave results
  createdAt: string            // ISO 8601
  updatedAt: string            // ISO 8601
  epicTaskId?: string          // brain task ID if materialized
}
```

### Save Points

Checkpoints are persisted after:
1. **`compute_waves()`** — After graph validation and wave computation.
2. **End of each wave** — After all nodes complete (success or failure).
3. **`clear_gate()`** — After merge gate confirmation.
4. **User refinement** — After graph modifications are approved.

### Version Compatibility

- Current version: `1.0.0`
- Deserialization enforces version match — mismatched versions abort.
- Future versions (1.1.0+) will implement forward-compatible migration logic.

### Refinement History

*Planned for 1.1.0:* Checkpoints will track refinement history:

```typescript
interface Checkpoint {
  // ... existing fields
  refinementHistory: Array<{
    timestamp: string
    addedNodes: string[]
    addedEdges: Edge[]
    addedRepos: string[]
  }>
}
```

This enables audit trails and partial rollback if needed.

---

## CLI Usage

Borgcube is invoked via the `/borgcube` skill. All operations preserve state in the brain checkpoint system.

### Fresh Invocation

```
/borgcube --include <brain-refs>
```

Start a new orchestration with specified target repositories. Launches planning, graph decomposition, and wave dispatch.

**Arguments:**
- `<brain-refs>` — Comma-separated list: brain names, aliases, or filesystem paths.
  Example: `/borgcube --include api,service,mobile-client`

### Resume from Checkpoint

```
/borgcube --resume [artifact-id | brain-ref]
```

Resume a prior execution. Optionally specify which checkpoint:
- **No argument** — Fetch latest `borgcube-checkpoint` artifact.
- **Artifact ID** (UUID) — Resume specific checkpoint.
- **Brain ref** (name/alias) — Resume latest checkpoint tagged `borgcube-repo:<ref>`.

**Behavior:**
- Loads checkpoint state and machine state.
- If new brains are specified (via implicit tag match), adds them to context.
- If machine state is `gate_halted`, checks PR merge status before resuming.
- If machine state is `failed`, presents failure triage options.

### Expand Scope on Resume

```
/borgcube --resume --include <additional-repos>
```

Add new repositories to an existing checkpoint. Triggers refinement mode:
1. Load checkpoint.
2. Detect new repos.
3. Present current graph + newly added repos.
4. User specifies new nodes for new repos and dependencies.
5. Recompute waves.
6. Resume dispatch.

### Dry-Run Planning

```
/borgcube --include <brain-refs> --dry-run
```

Plan and build the graph only. Do not dispatch Drones or create worktrees.
Returns:
- Decomposed nodes and edges.
- Computed waves in topological order.
- Wave plan summary.

Useful for validating graph structure before committing to execution.

---

## MCP Tools Reference

The UNIMATRIX MCP server exposes the following tools. All require an initialized checkpoint except `init` and `restore_checkpoint`.

| Tool | Purpose |
|------|---------|
| `init` | Initialize empty checkpoint in `initializing` state with repo metadata. |
| `add_repo` | Add repo to existing checkpoint. No-op if already present. |
| `add_node` | Add node to graph (id, repo, type, label, worktreeBranch, stackedOn?). |
| `add_edge` | Add directed edge: `from`, `to`, `type` (merge_gate \| stacked). |
| `validate` | Check graph integrity: edge refs, stackedOn refs, cycle detection (Kahn). |
| `compute_waves` | Compute topological waves, transition to `dispatching`. Validate first. |
| `dispatch_wave` | Activate all nodes in a wave, set currentWaveId. |
| `complete_node` | Mark node complete. Optionally record prUrl and prNumber. |
| `fail_node` | Mark node failed with human-readable reason. |
| `clear_gate` | Clear merge gate on blocked node. Auto-advances to `dispatching` if all gates cleared. |
| `next_wave` | Return next ready wave, or null with reason. |
| `status` | Return full state dump: machineState, nodes, edges, waves, waveHistory. |
| `save_checkpoint` | Serialize checkpoint to JSON string for persistence. |
| `restore_checkpoint` | Deserialize JSON and load as current checkpoint. |

---

## Execution Examples

### Example 1: Simple Contract-First Feature

```
Goal: Introduce gRPC service API.
Repositories: api (proto definitions), backend (service implementation).

/borgcube --include api,backend

Step 1: Plan
  User describes: "Define gRPC API in api repo, implement in backend."

Step 2: Graph
  Nodes:
    - grpc-defs [api] (contract)
    - grpc-impl [backend] (implementation)
  Edges:
    - grpc-defs --[merge_gate]--> grpc-impl

Step 3: Waves
  Wave 1: grpc-defs (hasMergeGate: true)
  Wave 2: grpc-impl (waits for grpc-defs merge)

Step 4: Dispatch
  Wave 1: Drone in api worktree defines .proto files, creates PR.
          User merges PR externally.
          Lead checks merge status, clears gate.
  Wave 2: Drone in backend worktree implements service, creates PR.
          Vinculum reviews changes.
          All done.
```

### Example 2: Multi-Repo with Stacked Changes

```
Goal: Add observability feature spanning multiple repos.
Repositories: shared-lib, service-a, service-b.

/borgcube --include shared-lib,service-a,service-b

Nodes:
  - observability-lib [shared-lib] (contract)
  - service-a-tracing [service-a] (implementation)
  - service-a-tests [service-a] (tests, stacks on service-a-tracing)
  - service-b-tracing [service-b] (implementation)

Edges:
  - observability-lib --[merge_gate]--> service-a-tracing
  - service-a-tracing --[stacked]--> service-a-tests
  - observability-lib --[merge_gate]--> service-b-tracing

Waves:
  Wave 1: observability-lib (hasMergeGate: true)
  Wave 2: service-a-tracing, service-b-tracing (parallel, await lib merge)
  Wave 3: service-a-tests (stacks on Wave 2's service-a-tracing)
```

### Example 3: Mid-Execution Scope Expansion

```
Initial: /borgcube --include api,backend

Execution reaches Wave 2, backend implementation underway.

User: "We also need web client support. Can we add it?"

Lead: /borgcube --resume --include web-client

Refinement:
  Current graph: api-contracts (done), backend-impl (active)
  New repo: web-client (added)
  User adds: web-client-impl [web-client] (implementation, depends on api-contracts)
  New wave plan computed.
  After approval, backend-impl completes, then web-client-impl dispatches.
```

---

## Comparison: Borgcube vs /assemble

| Aspect | Borgcube | /assemble |
|--------|----------|----------|
| **Scope** | Multiple repositories | Single repository |
| **Graph** | Explicit DAG, topological waves | Tasks tree, sequential/parallel chains |
| **Cross-repo dependency** | merge_gate edges | Implicit (via PR interdependencies) |
| **Pause points** | Merge gates (external confirmation) | Vinculum reviews (internal validation) |
| **Refinement** | Mid-execution repo additions | Task creation/re-planning |
| **Stacking** | Native: stacked edges | Manual: rebase management |
| **Checkpoint** | Persisted DAG state | Brain task tree |

**Use borgcube when:**
- Feature spans 2+ repositories.
- Merge gates are needed (external PR coordination).
- Graph topology is explicit (contract-first patterns).
- Stacked PRs within repos.

**Use /assemble when:**
- Single repository.
- Sequential/parallel task chains.
- Internal Vinculum validation sufficient.
- Task-based decomposition fits workflow.

---

## Troubleshooting

### "Cycle detected in graph"

The DAG has a cycle. Check edge definitions for circular dependencies.

Fix: Review edges, ensure no node transitively depends on itself.

### "No next wave available"

All available waves have unmet dependencies. Check:
- Are upstream `merge_gate` nodes in `merged` state?
- Are upstream `stacked` nodes in `pr_created` or `merged` state?

If a wave is stuck, use `/borgcube --resume` and triage via failure handling.

### "Machine is gate_halted"

External PRs must be merged. Use `/borgcube --resume` to check PR status and clear gates.

### "Execution failed"

One or more Drones reported failure. The machine entered `failed` state. Options:
- **retry** — Re-dispatch failed nodes.
- **diagnose** — Invoke `/diagnose` with failure logs.
- **abandon** — Close tasks, tear down worktrees, preserve results.

---

## Implementation Details

### Wave Computation Algorithm

Borgcube uses **Kahn's topological sort** with wave level assignment:

1. Compute in-degree for all edges.
2. Process nodes in topological order.
3. Propagate wave level: `merge_gate` edges advance level by 1; `stacked` edges do not.
4. Group nodes by final level to form waves.
5. Mark waves with `hasMergeGate: true` if any `merge_gate` edge originates from that level.

Result: topologically sorted waves, with merge gates as hard boundaries.

### State Machine Transitions

Strict state validation ensures:
- `plan_approved` only valid in `initializing`.
- Wave operations only valid in `dispatching`.
- `gate_cleared` only valid in `gate_halted`.
- `retry_wave` only valid in `failed`.

Illegal transitions throw an error. No silent state drift.

### Persistence & Recovery

- Checkpoints serialized to JSON, saved as brain artifacts.
- Tagged with `borgcube-checkpoint` for discovery.
- Tagged with `borgcube-repo:<name>` per repo for targeted resume.
- On resume, deserialize and validate version match.
- If version mismatch, abort with clear error (prevents silent data corruption).

