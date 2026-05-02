# Trimatrix Subgraphs

Subgraphs are the unit of dispatch in a trimatrix execution. The supergraph (all
nodes + edges) is partitioned into subgraphs; each subgraph is assigned to a
single executor — either the lead session or a dispatched adjunct. This document
is the canonical design note for the subgraph system.

Implementation lives in:

- `src/skills/trimatrix/graph.ts` — `computeSubgraphs`, `addSubgraph`,
  `subgraphOutcome`, `hashNodeSet`
- `src/skills/trimatrix/server.ts` — `compute_subgraphs`, `add_subgraph`,
  `list_subgraphs` MCP tool handlers
- `src/skills/trimatrix/types.ts` — `Subgraph`, `SubgraphSummary`,
  `SubgraphGate`, `SubgraphCompletionPolicy`, `SubgraphFailurePolicy`

---

## Two Flavors: Derived vs Explicit

### Derived subgraphs

Produced automatically by `compute_subgraphs` (the `computeSubgraphs` function
in `graph.ts`). Created whenever the caller calls
`mcp__unimatrix__compute_subgraphs` after the graph is built.

- The **lead subgraph** always receives the reserved ID `sg-lead` and contains
  all LEAD-executor nodes.
- **Adjunct subgraphs** are one per connected component of adjunct nodes. Each
  gets an ID of the form `auto-<8-char-hash>` where the hash is computed from
  the sorted set of node IDs in that component (`hashNodeSet` in `graph.ts`).
- `VERIFY_COMPILE` nodes are attached to their predecessor's component rather
  than forming their own subgraph.

Derived subgraphs have `derived: true` in their `Subgraph` record.

### Explicit subgraphs

Declared by the caller via `mcp__unimatrix__add_subgraph`. The caller supplies a
stable slug as the subgraph ID rather than accepting an auto-assigned one.

```
mcp__unimatrix__add_subgraph({
  slug: "auth-service",
  label: "Auth service drone",
  nodeIds: ["auth-impl", "auth-verify-compile"],
  executor: "ADJUNCT",
  tier: "T2",
  completionPolicy: "ALL",
  failurePolicy: "FAIL_FAST",
})
```

Explicit subgraphs have `derived: false`. They survive serialize→deserialize
unchanged (the full payload is carried in the `subgraph_added` event on the
checkpoint). Derived subgraphs are recomputed on restore, but hash-based IDs
remain stable as long as the member-node set does not change.

**When to use explicit subgraphs:** T2/T3 operations where partitions are known
up-front, stable across runs, and the operator wants to encode coordination
contracts (exports/imports/dependsOn) explicitly. For ad-hoc graphs where
partition boundaries emerge naturally from connectivity, derived subgraphs are
sufficient.

---

## Identity Rules

| ID form              | Who assigns it                | Immutable?                                |
| -------------------- | ----------------------------- | ----------------------------------------- |
| `sg-lead`            | `computeSubgraphs` (reserved) | Yes — always the lead subgraph            |
| `auto-<8-char-hash>` | `computeSubgraphs`            | Stable while member set is unchanged      |
| User slug            | `add_subgraph` caller         | Yes — slug becomes the ID for the session |

**Slug validation:** `^[a-z](?:[a-z0-9-]{0,39}[a-z0-9])?$` — 1–41 characters,
must start with a lowercase letter, end with a lowercase letter or digit, inner
chars from `[a-z0-9-]`. Must not equal `sg-lead` and must not start with
`auto-`. Slugs are case-sensitive and lowercase-only.

**Hash-input rule:** The hash is computed from the sorted node IDs of the
derived component (`hashNodeSet` in `graph.ts`). Adding or removing a _sibling_
adjunct component does not affect a component's hash, because the hash input is
that component's own node set. However, when an explicit subgraph claims nodes
that were previously part of a derived component, the remaining unclaimed nodes
form a smaller derived component with a different hash — its `auto-*` ID will
shift. This is the "M5 rename caveat": on the next `compute_subgraphs` call
after declaring an explicit subgraph, any derived subgraph that lost nodes to it
will receive a new `auto-*` ID.

---

## Policies

### Completion policies

<completion-policies evaluation-order="after-failure">
  <policy name="ALL" default="true">
    <when>Every member node must reach DONE, MERGED, or PR_CREATED.</when>
    <example>Standard drone partition — all files must be integrated.</example>
  </policy>
  <policy name="ANY">
    <when>The first member node to reach a terminal-OK state completes the subgraph.</when>
    <example>Competitive analysis — whichever approach validates first wins.</example>
  </policy>
  <policy name="GATED">
    <when>Every node listed in `gates` must reach terminal-OK; non-gate nodes may be in any state.</when>
    <example>A subgraph with a mandatory review node; optional exploratory nodes may be skipped.</example>
    <constraint>`gates` must be non-empty. Gate entries must be members of the subgraph's `nodeIds`.</constraint>
  </policy>
</completion-policies>

### Failure policies

<failure-policies evaluation-order="before-completion">
  <policy name="FAIL_FAST" default="true">
    <when>Any failed node fails the subgraph immediately.</when>
    <example>Standard partition — one broken file fails the whole partition.</example>
  </policy>
  <policy name="CONTINUE">
    <when>Subgraph fails only when every member node has failed.</when>
    <example>Best-effort migration — partial success is acceptable.</example>
  </policy>
  <policy name="BEST_EFFORT">
    <when>Gate failures fail the subgraph; non-gate failures are tolerated.</when>
    <example>Core-path nodes are gates; experimental nodes may fail silently.</example>
    <constraint>**Requires non-empty `gates`**. `add_subgraph` rejects a `BEST_EFFORT` spec without gates.</constraint>
  </policy>
</failure-policies>

### Policy interaction example

<example name="GATED + BEST_EFFORT" gates='["critical-node"]'>
  <case input="critical-node fails">subgraph → `failed`</case>
  <case input="a non-gate node fails">subgraph continues; failure is tolerated</case>
  <case input="critical-node reaches DONE and all other nodes settled (OK or tolerated-failed)">subgraph → `completed`</case>
</example>

---

## Gates

A gate is a `SubgraphGate` — either a **node ID** (string) or an **external
blocker** (object):

```typescript
// Node gate — clears when the node reaches terminal-OK
type NodeGate = string;

// External gate — clears when an external system reports resolution
type ExternalGate = {
  kind: "external";
  source: string; // e.g. "jira", "github-pr", "linear"
  externalId: string; // identifier within that system
  url?: string; // optional navigation URL
  taskId?: string; // optional associated brain task ID
};
```

**Node gates** are the standard form. The trimatrix engine tracks them against
node statuses via `subgraphOutcome` in `graph.ts`.

**External gates** allow a subgraph to express "gated on upstream PR / Jira
ticket" without injecting a placeholder node into the graph. External gates
carry `{ kind: "external", source, externalId, url?, taskId? }` and are resolved
via brain consultation when `taskId` is supplied.

Resolution flow: the caller declares a GATED subgraph with one or more external
gates → `dispatch_wave` consults the brain via `getExternalBlockers` →
unresolved blockers stamp `Node.externalBlockers` and set
`ReadinessStatus.BLOCKED` → resolution clears the gate and advances readiness.

External gates without a `taskId` cannot be resolved via brain consultation and
remain conservatively unresolved. The synchronous `subgraphOutcome` function
also treats all external gates as unresolved; use `subgraphOutcomeWithBlockers`
at the async dispatch boundary for snapshot-aware resolution.

---

## Immutability

<immutability-contract>
  <rule>Explicit subgraphs are append-only within a session.</rule>
  <forbidden-operations>
    <op>`remove_subgraph` (no such tool exists)</op>
    <op>`update_subgraph` (no such tool exists)</op>
  </forbidden-operations>
  <rationale>
    Mutation invariants are easier to reason about when the structural
    primitive is append-only. Coordination contracts, policies, and node
    membership are declared once and stable for the life of the session.
    This keeps checkpoint replay deterministic and adjunct prompts
    self-contained.
  </rationale>
  <to-revise>
    <option>Cancel the session and start over.</option>
    <option>Use `refine` to modify the node graph and declare new subgraphs on top of the updated structure. Derived subgraphs are recomputed against the new node set.</option>
  </to-revise>
</immutability-contract>

---

## materialize_plan Output Example

The `materialize_plan` MCP tool renders the full supergraph as a single Markdown
document (default) or JSON object. The Markdown form groups nodes by subgraph:
`sg-lead` first, then explicit subgraphs sorted by slug, then derived subgraphs
sorted by `auto-<hash>` ID. Within each subgraph, nodes appear in topological
(wave-stable) order.

```markdown
# Plan: Auth + UI migration

## Overview

- Intent: IMPLEMENT · Tier: T2 · Strategy: INDEPENDENT
- Waves: 2 · Nodes: 5

## Lead Subgraph (sg-lead)

**Executor:** LEAD · **Tier:** T2 · **Assignee:** LEAD · **Coordination:** NONE
· **Outcome:** pending **Completion:** ALL · **Failure:** FAIL_FAST

| Node   | Label                  | Wave | Type           | Status  | Readiness | Repo        | Task    | PR | Tags |
| ------ | ---------------------- | ---- | -------------- | ------- | --------- | ----------- | ------- | -- | ---- |
| lead-a | Implement auth handler | 1    | IMPLEMENTATION | DONE    | —         | api-service | unm-100 | —  | —    |
| lead-b | Type-check api-service | 2    | VERIFY_COMPILE | PENDING | —         | —           | —       | —  | —    |

## Subgraph: web-drone — Web UI drone (explicit)

**Executor:** ADJUNCT · **Tier:** T2 · **Assignee:** drone-adjunct-1 ·
**Coordination:** NONE · **Outcome:** active **Completion:** ALL · **Failure:**
FAIL_FAST

| Node  | Label                  | Wave | Type           | Status | Readiness | Repo    | Task | PR                                  | Tags     |
| ----- | ---------------------- | ---- | -------------- | ------ | --------- | ------- | ---- | ----------------------------------- | -------- |
| adj-x | Implement UI component | 1    | IMPLEMENTATION | ACTIVE | —         | web-app | —    | https://github.com/org/repo/pull/42 | frontend |

## Subgraph: auto-abc12345 (derived)

**Executor:** ADJUNCT · **Tier:** T2 · **Assignee:** drone-adjunct-2 ·
**Coordination:** NONE · **Outcome:** pending **Completion:** ALL · **Failure:**
FAIL_FAST

| Node  | Label                 | Wave | Type           | Status  | Readiness | Repo       | Task | PR | Tags |
| ----- | --------------------- | ---- | -------------- | ------- | --------- | ---------- | ---- | -- | ---- |
| drv-p | Migrate schema        | 1    | IMPLEMENTATION | PENDING | —         | db-service | —    | —  | —    |
| drv-q | Type-check db-service | 2    | VERIFY_COMPILE | PENDING | —         | —          | —    | —  | —    |
```

Tool signature: `materialize_plan({ format?: "markdown" | "json" }): string`.
Implementation: `src/skills/trimatrix/materialize.ts` (`buildPlan`,
`materializePlan`). Tests: `src/skills/trimatrix/materialize.test.ts`.

---

## Resume Contract

<resume-contract>
  <invariant name="explicit-survives-roundtrip">
    Explicit subgraphs survive checkpoint serialize→deserialize unchanged.
    The `subgraph_added` event carries the full subgraph payload. Event log
    persistence is implemented in `state.ts` via `replay()`, `appendEvent()`,
    and the `eventLog` field. Replay is append-only and idempotent on
    re-application of the same event sequence, so `cp.subgraphs` is
    reconstructed without re-calling `add_subgraph`.
  </invariant>
  <invariant name="derived-stable-under-recompute">
    Derived subgraphs are recomputed on restore via `compute_subgraphs`.
    Their `auto-*` IDs are stable as long as the member-node set has not
    changed between checkpoint and restore — which is guaranteed because
    node additions are also event-sourced.
  </invariant>
  <invariant name="state-machine-idempotency">
    Re-adding a subgraph with an existing ID is a no-op on replay and does
    not double-append entries to `cp.subgraphs`.
  </invariant>
</resume-contract>
