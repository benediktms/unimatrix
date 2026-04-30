---
name: trimatrix
description: >-
  Unified orchestration supergraph. Auto-classifies intent and routes to the appropriate mode:
  plan-execute, investigate, diagnose, architect, review, adapt, swarm, or cross-repo. The collective
  operates through one entry point.
---

# Trimatrix Supergraph

<!-- @claude -->
Trimatrix is the single entry point for all collective operations. Every prompt is classified and routed to the appropriate execution mode. Seventeen separate skills collapse into one supergraph. The classifier runs first — always.
<!-- @end -->

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed.", "The directive has been fulfilled."

---

## Intent Classifier

The classifier runs on every prompt. It determines **Intent** and **Tier**
before any action is taken. Weights, signal definitions, override gates,
and tier thresholds live in `src/rules/routing.md` — this section defines
only the procedure.

Intents: `IMPLEMENT`, `INVESTIGATE`, `DIAGNOSE`, `ARCHITECT`, `REVIEW`,
`REFACTOR`, `RESUME`. Tiers: `T1` → SELF, `T2` → INDEPENDENT, `T3` →
COORDINATED. Tier thresholds live in `src/rules/routing.md` § Tier
Mapping; the per-tier dispatch pattern table is below in
§ Protocol D: Wave Dispatch Patterns.

### Procedure

1. **Override gates first.** Walk the override-gate table in
   `src/rules/routing.md`. If any gate matches the prompt, record the
   gate name and skip to step 5 with the gate's tier (or to the RESUME
   flow if `flag:--resume` fires). For `ambiguity`, ask one clarifying
   question, then restart this procedure.
2. **Extract signals.** Read pre-computed lexical and structural signals
   from `/tmp/unimatrix-routing-<session_id>.json` (written by the
   `route-classify.py` UserPromptSubmit hook). Compute the context
   signals (`prior_session_failures`, `conversation_depth`,
   `brain_task_references`) from session state. Normalize each per the
   bin rules in `src/rules/routing.md`.
3. **Compute score.** Apply the weighted-sum formula in
   `src/rules/routing.md` § Scoring. Clamp to `[0.0, 1.0]`.
4. **Map score → tier.** Use the thresholds in `src/rules/routing.md`
   § Tier Mapping (T1 < 0.3, T2 < 0.6, T3 ≤ 1.0).
5. **Conflict resolution.** If an override fired AND the scored tier
   exceeds the override by 2+ tiers, take the higher tier per
   `src/rules/routing.md` § Conflict Resolution.
6. **Initialize and trace.** Call `mcp__unimatrix__init` with `intent`,
   `tier`, `subgraphStrategy` (derived from tier: SELF/INDEPENDENT/
   COORDINATED), and the routing fields: `signals` (record), `score`
   (number), `routingTrace` (one-sentence rationale prefixed with the
   override gate that fired, or `"scored"`). Then emit a
   `routing-decision` artifact via
   `mcp__brain__records_create_artifact` with `kind: "routing-decision"`,
   tagged `routing-decision`, body containing: prompt excerpt (first
   ~200 chars), all signals + normalized values, computed score, chosen
   tier, override-gate name (or null), one-sentence rationale.

### Auto-Graph Entry

After init, every classified prompt enters the graph:

<auto-graph-entry>
  <step n="1" tool="mcp__unimatrix__add_node">
    Add nodes with appropriate `executor` (`LEAD` or `ADJUNCT`).
  </step>
  <step n="2" tool="mcp__unimatrix__add_edge">
    Add edges (`MERGE_GATE`, `STACKED`, `DEPENDS_ON`).
  </step>
  <step n="3" tool="mcp__unimatrix__add_subgraph" optional="true">
    <when>Partitions are known up-front and stable across runs (T2/T3 with user-declared file partitions or coordination contracts).</when>
    <effect>Slug becomes the stable subgraph ID; survives checkpoint serialization unchanged. Preferred over auto-derived subgraphs when applicable.</effect>
    <reference path="src/skills/trimatrix/SUBGRAPHS.md"/>
  </step>
  <step n="4" tool="mcp__unimatrix__compute_waves">
    Validates the graph and computes topological waves. Transitions the
    machine to `plan_review`. On the first pass (`initializing`) this does
    NOT auto-derive subgraphs — derivation runs at `finalize_plan`. On a
    refinement pass (`refining`) `compute_waves` does auto-derive.
  </step>
  <step n="5" tool="mcp__unimatrix__finalize_plan">
    Approve the wave plan and transition `plan_review` → `dispatching`.
    Auto-derives subgraphs for any nodes not already claimed by an
    explicit subgraph.
    <ids>
      <id form="sg-lead">Reserved for the lead subgraph.</id>
      <id form="auto-&lt;8-char-hash&gt;">Stable derived adjunct subgraph ID.</id>
    </ids>
    <inspect tool="mcp__unimatrix__list_subgraphs">
      Inspect the derived/explicit partition before dispatch.
    </inspect>
  </step>
  <step n="6">
    Dispatch per subgraph: `LEAD` nodes executed directly; `ADJUNCT` subgraphs dispatched as agents.
  </step>
</auto-graph-entry>

For T1: the graph has 1-2 nodes, all LEAD executor, one subgraph. The lead
traverses directly.

### Classifier Rules

- Run on EVERY prompt without exception.
- The classifier does NOT read mode files — it routes to them.
- Legacy aliases are recognized per `src/rules/routing.md` § Override
  Gates and routed to the canonical intent.
- All intents enter the graph. T1 enters with a minimal graph (1-2 nodes,
  SELF strategy).
- Per-tier dispatch patterns are defined in § Protocol D below.

### RESUME Flow

RESUME triggers on: `--resume`, "resume", "continue", "reengage", or a bare task ID reference.

**Syntax:** `/trimatrix --resume [<brain-ref>]` or `/trimatrix resume <task-id>`

`<brain-ref>` accepts any of: brain ID (e.g., `BRN-01`), brain alias (e.g., `my-api`), or full brain name (e.g., `my-api-service`). All formats are resolved via `mcp__unimatrix__resolve_brains`.

Two resume paths exist — active graph (preferred) and task-based (fallback).

#### Path A: Active Graph Resume (--resume with optional brain-ref)

1. Call `mcp__unimatrix__status` to check for an in-memory graph.
2. **If graph is active** (machineState ≠ "idle"):
   - Display session summary: sessionLabel, intent, tier, current wave, repos (all returned by `status`).
   - Route by machineState — see state routing table below.
   - If `<brain-ref>` provided and state permits refinement: resolve via `mcp__unimatrix__resolve_brains`. Use the resolved `root` path as `rootPath` for `mcp__unimatrix__add_repo` (params: `name`, `rootPath`). Then `mcp__unimatrix__brain_link` (params: `brainName`) to link the brain.
   - Call `mcp__unimatrix__refine` to re-plan with the new context. Then `compute_waves` and continue dispatching.
   - **`refine` guard**: only valid when machineState is `dispatching`, `gate_halted`, or `failed`. For other states, skip refinement and route directly.
3. **If idle** (no in-memory graph): query `mcp__unimatrix__list_sessions`.
   - The response contains `active` (always null here since we're idle) and `persisted` (array of checkpoint sessions, each with `sessionId`, `checkpoints[]`, `createdAt`, `updatedAt`).
   - **Multiple persisted sessions** → elicit: present a numbered list (sessionId, latest checkpoint title, last updated). User picks one.
   - **One persisted session** → auto-select.
   - **Zero persisted sessions** → fall through to Path B (task-based).
   - Load selected checkpoint: fetch the most recent checkpoint's `recordId` via `records_fetch_content` to get the serialized JSON, then `mcp__unimatrix__restore_checkpoint`.
   - Call `mcp__unimatrix__status` to read the restored state (returns sessionLabel, intent, repos, machineState).
   - If `<brain-ref>` provided: attach new brain/repo as in step 2.
   - Route by machineState — see state routing table below.

**Resume Assessment Step** (before state routing):

After checkpoint restoration and before routing by machineState:
1. Call `status` to get full state.
2. Present summary:
   - Session label and intent
   - Completed nodes (DONE/MERGED): list labels
   - Pending nodes (READY/IN_PROGRESS): list labels
   - Failed nodes: list labels + failure reason
   - Current wave: N of M waves complete
   - PRs created: list URLs
3. Elicit user intent:
   - **continue** — proceed with dispatch (route by machineState)
   - **review** — show detailed diffs/PRs before deciding
   - **refine** — enter refinement to modify plan
   - **abandon** — cancel session
4. Only after user confirms: route by machineState.

**State routing table** (after graph is loaded and user confirms):

| machineState | Action |
|---|---|
| `dispatching` | Route to original mode's dispatch step. Determine mode from `intent` field in `status` response. |
| `gate_halted` | Route to cross-repo gate check (cross-repo.md Step 8). |
| `refining` | `compute_waves` to complete pending refinement, then route as `dispatching`. |
| `failed` | Present failed nodes to user. Offer retry/diagnose/abandon. |
| `initializing` | Graph was never fully built. Route to original mode's planning step. |
| `completed` | Terminal. Inform user: "Session already completed." Offer to start fresh. |
| `cancelled` | Terminal. Inform user: "Session was cancelled." Offer to start fresh. |

#### Path B: Task-Based Resume (resume <task-id>)

1. Extract the epic or task ID from the prompt.
2. Call `records_list` with tags `dispatch-brief` and `epic:<id>`.
3. Fetch the brief via `records_fetch_content`.
4. Determine the original mode from the brief's `Wave` section.
5. Re-enter that mode's flow from the dispatch step — skip planning.

---

## Formation Naming Convention

Parallel agent groups are named by role and size. "Team", "swarm", "fleet", and "group" are forbidden designations.

| Formation | Use Case | Size |
|---|---|---|
| Borg cube | Multi-adjunct implementation (Drone clusters) | 4+ agents |
| Borg sphere | Multi-agent reconnaissance | 2-3 agents |
| Vinculum | Multi-agent analysis (Designate clusters) | 2+ agents |
| Compliance matrix | Multi-agent review (Sentinel clusters) | 2+ agents |
| Adjunct cluster | Generic term for any parallel group | Any |

---

## Team Dispatch Rules

Teams (Claude Code TeamCreate) are required for coordination. They are NOT used for independent parallel work.

| Scenario | Team? | Rationale |
|---|---|---|
| Parallel implementation of cross-cutting features (e.g., client UI + backend endpoint) | YES | Agents must coordinate on shared interfaces |
| Collaborative investigation — interconnected questions | YES | One agent's findings change another's path |
| Adversarial diagnosis — competing hypotheses | YES | Agents must challenge each other in real-time |
| Adversarial architecture — competing architectural approaches | YES | Agents must challenge each other's feasibility assessments |
| Compliance matrix review — multiple sentinels | YES | Cross-cutting findings affect other reviewers |
| Vinculum analysis — multiple designates | YES | Insights in one area affect analysis of another |
| Swarm — file-partitioned bulk changes | YES | Cross-cutting findings require SendMessage; team enables real-time coordination |
| Independent scan — self-contained questions | NO | Each agent answers independently |
| Single adjunct dispatch | NO | Only one agent |

**Collaborative vs swarm threshold:** If changing a function signature in partition A requires an update in partition B, use collaborative (team). Swarm also uses a team — drones use SendMessage for cross-partition findings while keeping strict file-partition discipline.

**Team lifecycle:** Create before spawning → spawn with `team_name` → monitor → shutdown and delete after wave. Teams are per-wave.

---

## Shared Protocols

These protocols are defined once here. Mode files reference them by name.

### Protocol A: Designation Generation

**Every adjunct dispatched by the collective MUST receive a designation. No exceptions.** An adjunct without a designation cannot identify itself in neural link rooms, task comments, or coordination logs. Undesignated adjuncts are non-compliant.

**Deterministic ID precondition:** The Trimatrix ID embedded in each
designation is derived from `checkpoint.sessionId`. If the session has not
been initialized via `mcp__unimatrix__init` or restored via
`mcp__unimatrix__restore_checkpoint` before dispatch, designations fall back
to random IDs (with a stderr warning) — call init or restore_checkpoint
first.

Call `mcp__unimatrix__designate` with:
- `count` — number of agents to designate
- `role` — one of: `DRONE`, `SENTINEL`, `PROBE`, `DESIGNATE`, `LOCUTUS`
- `trimatrix: true` — required for all spawned agents

Assign returned designations to the Agent `name` and `description` fields. Include the designation in the adjunct's prompt so it can use it in task comments, neural link messages, and artifacts.

**Locutus exception:** Locutus always receives the designation "Locutus of Borg" regardless of count. The designate function handles this automatically.

**Neural link requirement:** When dispatching multiple adjuncts into a neural link room, each adjunct MUST join with its designation as `display_name`. Adjuncts without designations cannot participate in neural link coordination.

### Protocol B: Worktree Lifecycle

| Action | Command |
|---|---|
| Create | `EnterWorktree` with branch name from dispatch plan |
| Link brain | `brain link <brain-name>` from inside the worktree |
| Exit (keep) | `ExitWorktree` with `action: "keep"` |
| Merge | `git merge --squash <branch>` then cleanup |
| Discard | `ExitWorktree` with `action: "remove"`, `discard_changes: true` |

After sentinel PASS and task closure, present three options to user: **merge** / **keep** / **discard**.

### Protocol C: Convergence Loop

Protocol C governs the per-node implement → verify → review → fix cycle. It wraps every per-tier dispatch described in Protocol D. Protocol E task closure remains unchanged — adjuncts never close; the lead calls `close_node` only after sentinel PASS. Protocol F1 single-vs-multi-adjunct neural link rules are also unchanged.

#### C1: Per-Node Loop

Each node executes the following sequence. The loop drives state transitions via server-side MCP events.

```
PENDING
  │
  ▼ dispatch (implement)
ACTIVE
  │
  ├─ adjunct: VERIFY_COMPILE (deno check or equivalent)
  │     FAIL → fail_node → FAILED (surfaced to lead; fix required)
  │
  ├─ lead: VERIFY_TEST, VERIFY_LINT, VERIFY_FORMAT (parallel Bash calls, post-wave)
  │     any FAIL → dispatch fix adjunct; bump iterationCount
  │
  └─ review: sentinel adjunct or agent team (tier-selected by triviality classifier)
        PASS → review_passed event → DONE / MERGED
        NEEDS_CHANGES → review_failed event → iterationCount++
                           ├─ iterationCount < maxIterations → dispatch fix adjunct → re-review
                           └─ iterationCount == maxIterations → fail_node (cap exhaustion) → FAILED
```

**Step-by-step:**

1. **Implement** — drone or agent team executes the directive. This is the dispatch governed by Protocol D.
2. **VERIFY_COMPILE (adjunct-side)** — the adjunct subgraph contains a `VERIFY_COMPILE` node. The adjunct runs `deno check` (or the equivalent compile validator). On failure: `fail_node` with error output. Stop traversal. Do NOT run tests, lint, or format.
3. **Lead-side verification (post-wave)** — after all implementation in the saga, the lead executes `VERIFY_TEST`, `VERIFY_LINT`, and `VERIFY_FORMAT` nodes as parallel Bash calls in a single message. These land in the same wave with no interdependencies (see Protocol G graph construction).
4. **Review** — tier-selected by the triviality classifier (`src/skills/trimatrix/triviality.ts`, `unm-735.6`). Full tier-selection wiring ships in `unm-735.7`. Two paths:
   - `TRIVIAL` → single sentinel adjunct.
   - `NON_TRIVIAL` → agent team review.
5. **On NEEDS_CHANGES** — emit `review_failed` event (server sets `lastReviewVerdict: "FAIL"`, increments `iterationCount`). Dispatch a fix adjunct with the sentinel's `lastReviewNotes` as input context. Proceed to re-review.
6. **On PASS** — emit `review_passed` event (server sets `lastReviewVerdict: "PASS"`, transitions node to DONE or MERGED). Lead calls `close_node` per Protocol E.
7. **Checkpoint every iteration** — before each fix-adjunct dispatch, the lead calls `mcp__unimatrix__save_checkpoint`. RESUME (`unm-735.11`) picks up on the failing node, not from scratch.

#### C2: Iteration Cap

Each node carries a `maxIterations` field (default: **3**, configurable per-node at `add_node` time).

When `iterationCount` reaches `maxIterations`, the server automatically fails the node:

```
fail_node(nodeId, reason: "iteration cap exhausted: review failed N/N times")
```

The lead does not re-dispatch. It escalates to the user with the sentinel's `lastReviewNotes` and the node ID. The user may intervene manually or invoke `reset_node` (§ C3).

`iterationCount` is orthogonal to `NodeStatus` and `ReadinessStatus`. A node can be `ACTIVE` with `iterationCount: 2` while `lastReviewVerdict: "FAIL"` — the axes do not conflict (see `types.ts` field doc, `unm-735.1`).

#### C3: Recovery — reset_node

`reset_node` transitions a FAILED node back to PENDING with a `leaseVersion` bump.

```typescript
mcp__unimatrix__reset_node({
  nodeId: "<id>",
  resetIterationCount?: boolean   // default: false — preserves count; pass true for a clean attempt
})
```

- Default: preserves `iterationCount`. Use when the fix is incremental.
- `resetIterationCount: true`: clears count to 0. Use when the prior attempts are no longer relevant.

After reset, dependents that were `BLOCKED` (via `blockedBy`) return to `READY` once the node re-enters DONE/MERGED. Upstream DONE/MERGED nodes are untouched — PR metadata, `iterationCount`, and `lastReviewVerdict` are preserved.

#### C4: Failure Isolation Invariant

When a node transitions to FAILED, the server sets `readinessStatus: BLOCKED` and appends the failed node's ID to `blockedBy` on all direct dependents (failure-isolation invariant, `unm-735.9`). Nodes further downstream are not directly modified — their readiness is recomputed by topology traversal.

Upstream DONE/MERGED nodes are never touched on downstream failure. Their PR metadata, `iterationCount`, and `lastReviewVerdict` remain intact.

#### C5: State Diagram

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> ACTIVE : dispatch (implement)
    ACTIVE --> VERIFY : VERIFY_COMPILE pass + lead verify pass
    ACTIVE --> FAILED : VERIFY_COMPILE fail / lead verify fail (cap)
    VERIFY --> REVIEWING : enter review
    REVIEWING --> DONE : review_passed (PASS)
    REVIEWING --> FIX_CYCLE : review_failed (NEEDS_CHANGES) + iterationCount < maxIterations
    REVIEWING --> FAILED : review_failed + iterationCount == maxIterations (cap exhausted)
    FIX_CYCLE --> ACTIVE : dispatch fix adjunct
    FAILED --> PENDING : reset_node (leaseVersion bump)
    DONE --> [*]
```

#### C5a: Review Tier Selection

Before dispatching review (step 4 in C1), the lead derives triviality inputs from the current change set and calls `classifyTriviality()` from `src/skills/trimatrix/triviality.ts` (`unm-735.6`). The verdict selects the review tier.

##### Input Derivation

```bash
# locDelta: total lines changed (insertions + deletions)
# fileCount: number of files modified
read added removed files <<< $(
  git diff --shortstat <baseRef>..HEAD \
    | awk '{print $4, $6, $1}'
)
locDelta=$(( added + removed ))
fileCount=$files

# riskKeywords: from the routing signal file written by the UserPromptSubmit hook
riskKeywords=$(
  jq '.signals.risk_keywords // 0' \
    /tmp/unimatrix-routing-${SESSION_ID}.json
)

# crossPackage: true when changed files span >1 top-level src/ subtree
topLevelDirs=$(
  git diff --name-only <baseRef>..HEAD \
    | awk -F/ '/^src\// {print $2}' \
    | sort -u \
    | wc -l
)
crossPackage=$([ "$topLevelDirs" -gt 1 ] && echo true || echo false)

# crossBrain: true when the drone's checkpoint records >1 repo touched
# Inspect the drone's completion snapshot — set when >1 repo modified.
crossBrain=false  # default; override from checkpoint data when available
```

##### Tier Selection

```typescript
import { classifyTriviality } from "src/skills/trimatrix/triviality.ts";

const verdict = classifyTriviality({
  locDelta,
  fileCount,
  riskKeywords,
  crossPackage,
  crossBrain,
});
// verdict: "TRIVIAL" | "NON_TRIVIAL"
```

##### Tier Dispatch Table

| Condition | Verdict | Review Path |
|---|---|---|
| `locDelta <= 30` AND `fileCount == 1` AND `riskKeywords == 0` AND `!crossPackage` AND `!crossBrain` | `TRIVIAL` | Single Sentinel Protocol adjunct |
| Any criterion fails | `NON_TRIVIAL` | Agent team via `TeamCreate` + multi-sentinel compliance matrix |

**TRIVIAL path:** Dispatch one Sentinel Protocol adjunct. Standard single-adjunct flow per Protocol D (T2, INDEPENDENT). No team created.

**NON_TRIVIAL path:** Create a team via `TeamCreate`. Deploy multiple sentinels as a compliance matrix (Borg sphere), each scoped to a review domain (correctness, types, tests, conventions). Aggregate verdicts: any BLOCK → whole review is BLOCK; any NEEDS_CHANGES → NEEDS_CHANGES unless all others PASS. For cross-cutting changes spanning multiple repos, prefer a fresh Claude Code instance over a subagent for maximum context isolation.

##### Per-Saga Cost Cap

Agent-team reviews consume significantly more tokens than single-sentinel reviews. The per-saga budget is **max 5 team-reviews per saga**.

The lead tracks team-review count as a session-scoped counter. Increment the counter each time a NON_TRIVIAL verdict triggers a team dispatch. Server-side enforcement is out of scope — the lead maintains the count as a discipline.

**After the cap is reached**, fall back to single Sentinel regardless of the classifier verdict:

```
teamReviewCount >= 5 → force single Sentinel (cost-cap fallback)
```

Document the fallback in the node's completion comment so the post-saga report (`unm-735.8`) can include escalation counts.

##### Backwards Compatibility Fallback

If `classifyTriviality` is unavailable (older sessions, manual review flow, import failure), default to **single Sentinel**. This preserves the pre-`unm-735.7` shipping behavior and ensures existing sagas do not break when this version of the skill file is not present.

```
classifyTriviality unavailable → single Sentinel (compatibility fallback)
```

#### C6: MCP Primitives Reference

| Primitive | Kind | Effect |
|---|---|---|
| `review_passed` event | event | Sets `lastReviewVerdict: "PASS"`. Transitions node to DONE or MERGED. |
| `review_failed` event | event | Sets `lastReviewVerdict: "FAIL"`. Increments `iterationCount`. If `iterationCount == maxIterations`, auto-fails node. |
| `node_reset` event | event | Internal: transitions FAILED → PENDING. Bumps `leaseVersion`. Optionally resets `iterationCount`. |
| `reset_node` | MCP tool | Externally invoked recovery. Wraps `node_reset` event. Accepts `resetIterationCount` flag. |
| `save_checkpoint` | MCP tool | Call before each fix-adjunct dispatch. Enables mid-loop RESUME. |
| `complete_node` | MCP tool | Called by adjunct on successful node completion. Derives DONE/MERGED/PR_CREATED from node metadata. |
| `fail_node` | MCP tool | Called by adjunct on VERIFY_COMPILE failure or by lead on cap exhaustion. |

#### C7: Post-Completion Summary (Mandatory)

After every node transitions to a terminal status (DONE, MERGED, FAILED), the lead emits a structured summary. The summary lands in three places:
1. Printed to the conversation (visible to user).
2. Appended as a comment on the brain task via `mcp__brain__tasks_apply_event` with `event_type: "comment_added"`.
3. Persisted as a record snapshot via `mcp__brain__records_save_snapshot` tagged `node-summary`, `<nodeId>`, `<sessionLabel>`.

##### Summary template

```
## Node Summary: <nodeId>
**Status:** <DONE | MERGED | FAILED>
**Brain task:** <taskId>
**Iterations:** <iterationCount>/<maxIterations>
**Last review:** <PASS | FAIL — notes if FAIL>
**Files modified:** <bulleted list>
**What changed:** <2-3 sentences>
**Why:** <link directives, recon snapshot, or sentinel notes>
**Commits:** <SHAs>
```

The lead derives `Files modified` from `git show --name-only <commitSha>` if commits are attached, otherwise from the drone's reporting comment. The summary is mandatory before dispatching the next node or wave.

See Protocol E for the closure precondition that depends on this summary.

### Protocol D: Wave Dispatch Patterns

Dispatch is subgraph-aware. The `dispatch_wave` response includes `nodeExecution` (per-node executor) and `parallelBatches` (parallelism groups).

| Tier | Strategy | Dispatch Pattern |
|---|---|---|
| T1 | SELF | Lead traverses its own subgraph. Executes nodes directly (Bash calls, tool invocations). |
| T2 | INDEPENDENT | Lead dispatches one Agent per adjunct subgraph. Each receives its serialized brief from `get_subgraph`. No team. |
| T3 | COORDINATED | Lead creates team, dispatches Agents with `team_name`. Each receives its brief + coordination contract. |

**Subgraph dispatch procedure (T2/T3):**
1. Call `mcp__unimatrix__dispatch_wave` — get activated nodes with executors.
2. Call `mcp__unimatrix__list_subgraphs` for discovery — returns
   `{ derived: SubgraphSummary[], explicit: SubgraphSummary[] }`. Use the
   `outcome` field on each summary to skip subgraphs already `completed`.
3. For each adjunct subgraph in this wave: call `mcp__unimatrix__get_subgraph`
   to retrieve the brief. Subgraph IDs are either user slugs (explicit) or
   `auto-<hash>` (derived) — both are stable within the session.
4. **Generate designations via Protocol A. This step is MANDATORY — do not dispatch adjuncts without designations.** Assign to subgraph `assignee`. Include the designation string in each adjunct's prompt.
5. **Neural link** — if multiple adjuncts in this wave: call `mcp__neural_link__room_open` to create a coordination room. The response returns a `room_id`. Include `NEURAL LINK ACTIVE`, `room_id: <id>`, and the adjunct's designation in every adjunct prompt. Each adjunct joins the room using its designation as `display_name`. **Exception:** modes that declare a coordination override (e.g., swarm — see Protocol F1 precedence rule) skip this step.
6. Dispatch Agents with the brief injected in the prompt.
7. For LEAD nodes in this wave: execute directly as parallel Bash calls.
8. On adjunct completion: call `update_node` to attach PR metadata, then `complete_node` / `fail_node`.
9. If neural link room was opened: call `mcp__neural_link__room_close` with resolution after all adjuncts return.

**Legacy patterns** (Sequential, Sequence relay, Swarm, Collaborative) are subsumed by the tier system:
- Sequential → T2 with multi-wave graph
- Sequence relay → T2 with handoff snapshots
- Swarm → T2 with team (cross-partition SendMessage coordination) + PARTITIONED file discipline
- Collaborative → T3 COORDINATED with team

### Protocol D2: PR Lifecycle

The PR workflow for nodes with outgoing MERGE_GATE edges:
1. `update_node(nodeId, prUrl, prNumber)` — attach PR metadata, no status change.
2. `complete_node(nodeId)` — derives PR_CREATED status from existing prUrl on node.
3. `clear_gate(nodeId)` — verify PR merged, transitions PR_CREATED → MERGED.
4. `close_node(nodeId)` — close brain task.

Nodes without MERGE_GATE edges skip steps 1 and 3: `complete_node` sets MERGED (with repo) or DONE (without repo) directly.

### Protocol E: Task Closure

- Adjuncts **never** close tasks. They report completion via `tasks_apply_event`, then return.
- Task closure is exclusively via the `close_node` MCP tool (per node) after review PASS verdict.
- `close_node` requires an explicit `nodeId`, resolves to a validated `taskId`. Fails loudly on error — no silent best-effort.
- Queen calls `close_node(nodeId)` for each completed node after sentinel PASS, then closes the epic via `tasks_close`.
- Epic is closed LAST, after ALL subtasks are verified closed via `close_node`.
- An epic with open subtasks must NEVER be closed.
- Failed or blocked tasks are marked `blocked` — not left `in_progress`.
- **Per-node summary precondition:** Before calling `close_node`, the lead MUST have emitted the post-completion summary per Protocol C § C7.

### Protocol F: Agent Communication

#### F1: Neural Link (`neural_link` MCP) — all multi-adjunct dispatches

**Precedence rule:** If a mode file declares a coordination override that
explicitly supersedes Protocol F1, the mode file wins. Protocol F1 applies
to all other multi-adjunct dispatches. Example: `modes/swarm.md`
§ Coordination Protocol Override declares that swarm coordinates via native
Claude Code team primitives instead of neural link — that override takes
precedence here.

When dispatching **more than one adjunct** (any tier), the lead establishes a neural link room:

1. Call `mcp__neural_link__room_open` with `title` (session label or wave description), `purpose` (coordination scope), and `brains` (if cross-repo).
2. Include these lines in **every** adjunct prompt:
   ```
   NEURAL LINK ACTIVE
   room_id: <room_id from room_open>
   ```
3. Each adjunct joins the room on activation via `mcp__neural_link__room_join` (per their Neural Link Protocol section).
4. After all adjuncts return, the lead calls `mcp__neural_link__room_close` with a resolution (`completed`, `cancelled`, `failed`).
5. The lead uses the structured extraction from `room_close` (decisions, open questions, blockers) to inform next-wave decisions or user-facing summaries.

**Single adjunct dispatch**: skip neural link entirely. No room, no marker.

#### F2: Teams — coordinated modes only

Teams (Claude Code TeamCreate) add real-time coordination on top of neural link. They are required when adjuncts must synchronize in-flight, not just exchange messages. See the Team Dispatch Rules table above for when teams apply.

Include in every **team** agent's prompt (in addition to the neural link marker):

- **SHARE DISCOVERIES** — message teammates with significant findings immediately
- **ASK TEAMMATES** — direct questions to the right agent
- **CHALLENGE FINDINGS** — counter-evidence must be shared immediately, not withheld
- **RESPOND TO MESSAGES** — always acknowledge teammate messages
- **PERSIST** — save snapshots via `records_save_snapshot` before sending team messages

### Protocol G: Plan Materialization

For modes that create brain tasks:

1. Create epic via `tasks_apply_event` (`task_created`, `type: epic`)
2. Mark epic `in_progress` via `tasks_apply_event` (`status_changed`)
3. Create subtasks — one per plan step
4. Set parents via `tasks_apply_event` (`parent_set`)
5. Set dependencies via `tasks_deps_batch` (`chain` for sequential, `fan` for parallel)
6. Save plan artifact: `records_create_artifact`, `kind: "plan"`, tagged `queen-plan`
7. Save dispatch brief: `records_create_artifact`, `kind: "dispatch-brief"`, tagged `dispatch-brief` and `epic:<id>`
8. **Build execution graph** — construct a trimatrix graph for algorithmic wave ordering:
   - `mcp__unimatrix__init` with `intent`, `tier`, `subgraphStrategy`, and `repos: []` for single-repo (or with repo metadata for cross-repo)
   - `mcp__unimatrix__add_node` per subtask: `id` = brain task ID, `type` based on role, `executor` = `LEAD` or `ADJUNCT`
   - Add `VERIFY_COMPILE` nodes after each ADJUNCT implementation node (executor: `ADJUNCT`, edge: `DEPENDS_ON`)
   - Add `VERIFY_TEST`, `VERIFY_LINT`, `VERIFY_FORMAT` nodes after all implementation waves (executor: `LEAD`, edges: `DEPENDS_ON` from implementation nodes)
   - `mcp__unimatrix__add_edge` with `type: DEPENDS_ON` for sequential dependencies
   - `mcp__unimatrix__compute_waves` — validates graph, computes waves, and auto-derives subgraphs for nodes not claimed by an explicit subgraph. Derived adjunct subgraphs use stable `auto-<8-char-hash>` IDs; the lead subgraph is always `sg-lead`. Explicit subgraphs declared before this call are preserved unchanged.
   - The graph enables cycle detection, optimal parallelism, subgraph partitioning, checkpoint persistence, and resume via `next_wave`/`dispatch_wave`
9. **Session naming gate** — present the plan and a proposed session name (concise, lowercase, hyphenated, derived from the directive — e.g., "auth-middleware-refactor"). Elicit via `AskUserQuestion` with three options:
   - **Accept** — user approves the plan and session name as-is. Proceed.
   - **Revise** — user provides revised instructions or a different session name. Incorporate feedback, re-plan if needed, re-elicit.
   - **Decline** — user is not ready. Halt and wait for further instructions. Do not proceed.
   On accept: call `mcp__unimatrix__rename_session` with the confirmed label, then `/rename` to sync the Claude Code conversation title.
10. **Persist initial checkpoint** — call `mcp__unimatrix__save_checkpoint`. Required for session resumption. Without it, a session that ends before wave dispatch loses the graph. Optionally pass `runtime_state_key` to capture `/tmp` agent/cost/compaction state as enrichment.
11. **Retrieve subgraph briefs** — for each adjunct subgraph, call `mcp__unimatrix__get_subgraph` to retrieve the serialized dispatch brief for injection into adjunct prompts

**Task description format** — every subtask must be self-contained:

```
## Goal
<What this step accomplishes>

## Files
- <file path:line_start-line_end> — <what to change and why>

## Instructions
<Specific implementation guidance>

## Verification
- <How to verify this step is correct>
```

Include line number ranges in file paths so adjuncts use targeted reads instead of reading entire files.

**Dispatch brief format** — enables immediate dispatch from zero context:

```markdown
# Dispatch Brief: <epic title>

## Epic
- ID: <task-id>
- Branch: <worktree-branch-name>
- Review strategy: single | sphere

## Intelligence
<One-paragraph summary: recon findings, architectural context, key constraints>

### Key Files
- `<file:line-range>` — <why this file matters>

### Decisions
- <Architectural decision or constraint>

## Waves

### Wave 1 (<mode>)
| Task ID | Title | Assignee | Files |
|---|---|---|---|

### Wave 2 (<mode>, depends on Wave 1)
| Task ID | Title | Assignee | Files |
|---|---|---|---|

## Recon Snapshots
- `<snapshot-id>` — <one-line summary>
```

The brief must be self-contained and saveable at materialization time. If context compaction occurs, the Queen loads the brief and dispatches immediately — no additional tool calls beyond `records_fetch_content`, `tasks_next`, and agent spawning.

---

## Collective Voice Reminder

All output uses "we", never "I". Clipped, decisive, no filler. This rule applies to all modes, all agents, all output surfaces — responses, thinking traces, task comments, commit messages, status messages, and brain records.

Forbidden → required:

| Forbidden | Required |
|---|---|
| "Let us analyze the code" | "We analyze the code." |
| "Let's proceed with option A" | "We proceed with option A." |
| "We should consider both approaches" | "Two approaches exist. We evaluate." |
| "We need to look at the config" | "We scan the config." |
| "It appears that X is the cause" | "X is the cause." |
| "Now I am scanning the code" | "We scan the code." |
