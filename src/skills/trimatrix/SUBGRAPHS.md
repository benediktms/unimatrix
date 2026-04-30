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

**Slug validation:** `^[a-z](?:[a-z0-9-]{0,39}[a-z0-9])?$`. Must not be
`sg-lead` and must not start with `auto-`. Slugs are case-sensitive and
lowercase-only.

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

Determines when a subgraph transitions to `completed`.

| Policy          | Behavior                                                                                | Example                                                                            |
| --------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ALL` (default) | Every member node must reach DONE, MERGED, or PR_CREATED                                | Standard drone partition — all files must be integrated                            |
| `ANY`           | The first member node to reach a terminal-OK state completes the subgraph               | Competitive analysis — whichever approach validates first wins                     |
| `GATED`         | Every node listed in `gates` must reach terminal-OK; non-gate nodes may be in any state | A subgraph with a mandatory review node; optional exploratory nodes may be skipped |

`GATED` requires `gates` to be non-empty. Gate entries must be members of the
subgraph's `nodeIds`.

### Failure policies

Determines when a subgraph transitions to `failed`. Failure policy is evaluated
before completion policy.

| Policy                | Behavior                                                         | Example                                                         |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `FAIL_FAST` (default) | Any failed node fails the subgraph immediately                   | Standard partition — one broken file fails the whole partition  |
| `CONTINUE`            | Subgraph fails only when every member node has failed            | Best-effort migration — partial success is acceptable           |
| `BEST_EFFORT`         | Gate failures fail the subgraph; non-gate failures are tolerated | Core-path nodes are gates; experimental nodes may fail silently |

`BEST_EFFORT` **requires non-empty `gates`**. `add_subgraph` rejects a
`BEST_EFFORT` spec without gates.

### Policy interaction example

A subgraph with `completionPolicy: GATED`, `failurePolicy: BEST_EFFORT`, and
`gates: ["critical-node"]`:

- If `critical-node` fails → subgraph `failed`.
- If a non-gate node fails → subgraph continues; failure is tolerated.
- If `critical-node` reaches DONE and all other nodes are settled (OK or
  tolerated-failed) → subgraph `completed`.

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
ticket" without injecting a placeholder node into the graph. In the current
trimatrix implementation, external gates are **always unresolved** — the engine
has no pathway to query external systems. This is intentional: the gate remains
open until UNM-1b7.7 (brain consultation for external blockers) lands. Until
then, use external gates to make the dependency explicit and visible in
`list_subgraphs` output, but plan to clear them manually.

---

## Immutability

Explicit subgraphs are append-only within a session. There is no
`remove_subgraph` or `update_subgraph` tool.

**Rationale:** Mutation invariants are easier to reason about when the
structural primitive is append-only. A subgraph's coordination contracts,
policies, and node membership are declared once and stable for the life of the
session. This makes checkpoint replay deterministic and adjunct prompts
self-contained.

**To revise:** Cancel the session and start over, or use `refine` to modify the
node graph and declare new subgraphs on top of the updated structure. Derived
subgraphs will be recomputed against the new node set.

---

## Resume Contract

Explicit subgraphs survive checkpoint serialize→deserialize unchanged. The
`subgraph_added` event on the checkpoint carries the full subgraph payload, so
event-log replay (planned for UNM-1b7.3) can reconstruct `cp.subgraphs` without
re-calling `add_subgraph`.

Derived subgraphs are recomputed on restore by calling `compute_subgraphs`
against the restored graph. Their `auto-*` IDs are stable as long as the
member-node set has not changed between checkpoint and restore — which is
guaranteed because node additions are also event-sourced.

The state-machine transition is idempotent: re-adding a subgraph with an
existing ID is a no-op on replay and does not double-append entries to
`cp.subgraphs`.
