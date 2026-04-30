/**
 * Shared TypeScript types for the trimatrix cross-repository orchestration system.
 *
 * These interfaces define the state machine, execution graph, and all data
 * structures used throughout the trimatrix skill.
 */

// ---------------------------------------------------------------------------
// Graph enums
// ---------------------------------------------------------------------------

export enum NodeType {
  CONTRACT = "CONTRACT",
  IMPLEMENTATION = "IMPLEMENTATION",
  RECON = "RECON",
  VALIDATION = "VALIDATION",
  DOCUMENTATION = "DOCUMENTATION",
  DIAGNOSIS = "DIAGNOSIS",
  ANALYSIS = "ANALYSIS",
  ELICIT_GATE = "ELICIT_GATE",
  VERIFY_COMPILE = "VERIFY_COMPILE",
  VERIFY_TEST = "VERIFY_TEST",
  VERIFY_LINT = "VERIFY_LINT",
  VERIFY_FORMAT = "VERIFY_FORMAT",
  REFLECT = "REFLECT",
}

export enum NodeStatus {
  PENDING = "PENDING",
  ACTIVE = "ACTIVE",
  PR_CREATED = "PR_CREATED",
  MERGED = "MERGED",
  /**
   * @deprecated as of 2.5.0 — execution-vs-topology concerns are split into
   * `NodeStatus` (execution lifecycle) and `ReadinessStatus` (topology
   * eligibility). Existing usage of `BLOCKED` is preserved for ELICIT_GATE
   * pending elicitation; new code should set `readinessStatus` instead and
   * use `executionStatus` for actual execution lifecycle. Will be removed
   * once all call sites migrate.
   */
  BLOCKED = "BLOCKED",
  FAILED = "FAILED",
  DONE = "DONE",
}

/**
 * Readiness state — the topology-eligibility axis of a node, orthogonal to
 * `NodeStatus` (execution lifecycle).
 *
 * - `READY` — every incoming dependency edge is satisfied. Eligible for
 *   dispatch when `NodeStatus` is `PENDING`.
 * - `BLOCKED` — at least one incoming dependency is unsatisfied (source node
 *   is not in a terminal-OK state, or carries an unresolved external blocker).
 *   Recomputed automatically on every state transition.
 * - `INVALIDATED` — the node's contract was changed via `refine` after it had
 *   been computed; explicit re-dispatch is required to clear back to `READY`.
 *   Set explicitly by refinement code; never auto-cleared.
 *
 * A node can be `ACTIVE` (executing) and `INVALIDATED` (topology says it's
 * stale) simultaneously. The single `NodeStatus` enum cannot express that;
 * the orthogonal axis can.
 */
export enum ReadinessStatus {
  READY = "READY",
  BLOCKED = "BLOCKED",
  INVALIDATED = "INVALIDATED",
}

export enum EdgeType {
  MERGE_GATE = "MERGE_GATE",
  STACKED = "STACKED",
  DEPENDS_ON = "DEPENDS_ON",
}

// ---------------------------------------------------------------------------
// Intent and execution enums
// ---------------------------------------------------------------------------

export enum Intent {
  IMPLEMENT = "IMPLEMENT",
  INVESTIGATE = "INVESTIGATE",
  DIAGNOSE = "DIAGNOSE",
  ARCHITECT = "ARCHITECT",
  REVIEW = "REVIEW",
  REFACTOR = "REFACTOR",
}

export enum Tier {
  T1 = "T1",
  T2 = "T2",
  T3 = "T3",
}

export enum SubgraphStrategy {
  SELF = "SELF",
  INDEPENDENT = "INDEPENDENT",
  COORDINATED = "COORDINATED",
}

export enum CoordinationMode {
  NONE = "NONE",
  PARTITIONED = "PARTITIONED",
  ADVERSARIAL = "ADVERSARIAL",
  CROSS_REPO = "CROSS_REPO",
}

export enum Executor {
  LEAD = "LEAD",
  ADJUNCT = "ADJUNCT",
}

// ---------------------------------------------------------------------------
// Capability matching types
// ---------------------------------------------------------------------------

/**
 * Capabilities a dispatcher (lead session or adjunct) advertises. Used at
 * dispatch time to decide whether a node's requirements are satisfied.
 */
export interface Capabilities {
  /** Repository names the dispatcher can write to (`"*"` means all). */
  repos?: string[];
  /** Tool names the dispatcher can invoke (e.g. `"bash"`, `"edit"`, `"web"`). */
  tools?: string[];
  /** Whether the dispatcher can write code (vs. read-only analysis). */
  canWrite?: boolean;
  /** Whether a human is present to handle elicitation prompts. */
  humanPresent?: boolean;
  /** Free-form labels for custom matching. */
  labels?: string[];
}

/** Requirements a node declares. Subset semantics: every requirement must be
 *  satisfied by the dispatcher's `Capabilities` for `canDispatch` to return true. */
export type Requirements = Capabilities;

// ---------------------------------------------------------------------------
// Routing types
// ---------------------------------------------------------------------------

/**
 * Routing decision trace captured at classification time.
 * Persisted on the checkpoint for audit and tuning.
 */
export interface RoutingTrace {
  /** Signal name → numeric value computed by the classifier. */
  signals: Record<string, number>;
  /** Composite score in [0, 1] computed from weighted signals. */
  score: number;
  /** One-sentence rationale describing the routing decision. */
  trace: string;
  /** Override gate that fired (e.g., "scope:quick", "flag:--include"), if any. */
  override?: string;
}

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

/**
 * A single unit of work in the trimatrix execution graph.
 * Corresponds to one branch/PR per repository (or a single-repo task when repo is absent).
 */
export interface Node {
  /** Unique identifier for this node within the graph. */
  id: string;
  /** Brain name or ref identifying the target repository. Absent for single-repo nodes. */
  repo?: string;
  /** The kind of work this node represents. */
  type: NodeType;
  /** Human-readable description of this node's purpose. */
  label: string;
  /** Optional tags for categorisation or filtering. */
  tags?: string[];
  /** Brain task ID once the corresponding task has been materialized. */
  taskId?: string;
  /** Name of the worktree branch for this node. Absent for single-repo nodes. */
  worktreeBranch?: string;
  /** Node ID this node is stacked on within the same repository. */
  stackedOn?: string;
  /** Current execution status of this node. */
  status: NodeStatus;
  /**
   * Topology-eligibility axis, orthogonal to `status`.
   * - `READY` (default) — incoming dependencies satisfied; eligible for dispatch.
   * - `BLOCKED` — at least one incoming dependency unsatisfied; recomputed automatically.
   * - `INVALIDATED` — node's contract changed via refinement; explicit re-dispatch required.
   *
   * Introduced in checkpoint version 2.5.0. Pre-2.5.0 checkpoints default to
   * `READY` on deserialize; subsequent transitions recompute the field.
   *
   * Optional at the type level so callers constructing fresh `Node` literals
   * (MCP `add_node` tool, test fixtures) do not have to thread the default.
   * `addNode`, `createCheckpoint`, and `recomputeReadiness` backfill on entry.
   */
  readinessStatus?: ReadinessStatus;
  /** URL of the pull request created for this node, if any. */
  prUrl?: string;
  /** Number of the pull request created for this node, if any. */
  prNumber?: number;
  /** Human-readable reason for failure, if status is FAILED or BLOCKED. */
  failureReason?: string;
  /** Subgraph this node belongs to. Assigned by computeSubgraphs. */
  subgraph?: string;
  /** Who executes this node: the lead session or a dispatched adjunct. */
  executor: Executor;
  /** Capability requirements that must be satisfied by the dispatcher before this node can be dispatched. */
  requirements?: Requirements;
  /** Markdown prompt/context to present to the user during elicitation. Only for ELICIT_GATE nodes. */
  elicitPrompt?: string;
  /** JSON Schema for the elicitation form. Only for ELICIT_GATE nodes. Defaults to approval schema if omitted. */
  elicitSchema?: ElicitationRequestedSchema;
  /** User's structured response after elicitation completes. Populated by clear_gate. */
  elicitResponse?: Record<string, unknown>;
  /**
   * Opaque UUID minted by `dispatch_wave` to identify the current dispatch
   * attempt. Callers must echo this back in `complete_node` / `fail_node` /
   * `update_node` for fence validation. Absent until the node is first dispatched.
   */
  attemptId?: string;
  /**
   * Monotonically incrementing counter stamped on the node each time it is
   * dispatched or invalidated by `refine` / `cancel`. Callers must echo the
   * version they received; a mismatch means the node has been re-fenced since
   * dispatch and the write is rejected. Absent until the node is first dispatched.
   */
  leaseVersion?: number;
  /**
   * Cached external-blocker snapshots from the last brain consultation at dispatch time.
   * Populated by dispatch_wave when `taskId` is set; cleared on each new consultation.
   * Type mirrors ExternalBlockerSnapshot in brain-sync.ts (duplicated to avoid a
   * circular import — types.ts must not import from brain-sync.ts).
   */
  externalBlockers?: Array<{
    source: string;
    externalId: string;
    url?: string;
    taskId?: string;
    resolvedAt?: number;
  }>;
  /**
   * Whether `dispatch_wave`'s most recent brain consultation found unresolved
   * external blockers. **Orthogonal axis** to `readinessStatus`:
   * - `readinessStatus` reflects topology (edge satisfaction), recomputed
   *   automatically by `recomputeReadiness` on every status-changing event.
   * - `externallyBlocked` reflects brain state (cross-system gates), set
   *   explicitly by `dispatch_wave` and only cleared by the next dispatch.
   *
   * Both axes must be `READY` and `false` respectively for a node to be
   * frontier-eligible. The split avoids the "single field, two writers" race
   * where `recomputeReadiness` would silently overwrite an external-blocker
   * BLOCKED marker on the next `node_completed` event.
   */
  externallyBlocked?: boolean;
  /**
   * Number of times this node has re-entered the implement→review→fix loop.
   * Starts at 0 on creation; incremented by the `review_failed` event handler
   * (Wave 2, unm-735.2). Read by the convergence-cap check in `dispatch_wave`
   * before activation.
   *
   * **Orthogonal axes note:** `iterationCount` tracks loop cycles, which is
   * independent of both `NodeStatus` (execution lifecycle: PENDING → ACTIVE →
   * DONE/FAILED) and `ReadinessStatus` (topology eligibility: READY/BLOCKED/
   * INVALIDATED). A node may be FAILED due to cap exhaustion while its
   * `readinessStatus` remains READY — the axes do not conflict.
   *
   * Introduced in checkpoint version 2.7.0. Pre-2.7.0 checkpoints default to
   * 0 on deserialize (see `state.ts` backfill). Optional at the type level so
   * callers constructing fresh `Node` literals do not have to supply it;
   * `addNode` in `graph.ts` backfills the default on creation.
   */
  iterationCount?: number;
  /**
   * Maximum number of review→fix iterations before the node is hard-failed.
   * Configurable per node at `add_node` time; defaults to 3.
   *
   * When `iterationCount` reaches `maxIterations`, the convergence loop
   * marks the node `FAILED` with a cap-exhaustion reason rather than
   * re-dispatching. Optional at the type level; backfilled to 3 by `addNode`
   * and `deserialize`.
   */
  maxIterations?: number;
  /**
   * Verdict from the most recent sentinel review of this node.
   * Set by `review_passed` (→ `"PASS"`) and `review_failed` (→ `"FAIL"`) event
   * handlers (Wave 2, unm-735.2). Absent until the first review completes.
   *
   * Orthogonal to `NodeStatus`: a node may be `ACTIVE` while `lastReviewVerdict`
   * is `"FAIL"` (fix iteration in progress) or absent (never reviewed).
   */
  lastReviewVerdict?: "PASS" | "FAIL";
  /**
   * Free-form notes from the most recent sentinel review.
   * Populated alongside `lastReviewVerdict` by the review event handlers.
   * Absent until the first review completes.
   */
  lastReviewNotes?: string;
  /**
   * IDs of upstream nodes that are currently in FAILED status and block this
   * node. Populated and cleared by `recomputeReadiness` in graph.ts:
   * - When a predecessor transitions to FAILED, its ID is appended here.
   * - When a predecessor is reset (back to PENDING via `node_reset`), its ID
   *   is removed; if the list empties and all other deps are satisfied the
   *   node returns to READY.
   *
   * A non-empty `blockedBy` implies `readinessStatus === BLOCKED`.
   * An empty (or absent) `blockedBy` does NOT imply READY — there may still
   * be unsatisfied-but-not-failed predecessors (e.g. PENDING, ACTIVE).
   *
   * Introduced alongside the failure-isolation invariant (UNM-735.9).
   * Pre-existing checkpoints treat `undefined` as `[]` (backfill compat).
   */
  blockedBy?: string[];
}

/**
 * A directed dependency edge between two nodes in the execution graph.
 */
export interface Edge {
  /** Source node ID. */
  from: string;
  /** Target node ID. */
  to: string;
  /**
   * Relationship type:
   * - `MERGE_GATE`: target cannot proceed until source is merged.
   * - `STACKED`: target branch is stacked on top of source within one repo.
   * - `DEPENDS_ON`: target cannot proceed until source is done or merged (single-repo friendly).
   */
  type: EdgeType;
}

/**
 * A single entry in the continuous frontier — a PENDING+READY node with its
 * wave membership attached for consumer batching and UI purposes.
 */
export interface FrontierEntry {
  /** Node identifier. */
  nodeId: string;
  /** Wave number the node belongs to. */
  wave: number;
}

/**
 * The full directed acyclic graph of nodes and edges for one trimatrix execution.
 */
export interface Graph {
  /** All nodes in the graph, keyed by node ID for O(1) lookup and JSON compatibility. */
  nodes: Record<string, Node>;
  /** All directed edges in the graph. */
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Subgraph types
// ---------------------------------------------------------------------------

/**
 * Coordination contract governing how a subgraph interacts with sibling subgraphs.
 */
export interface CoordinationContract {
  /** Coordination mode determining isolation and communication rules. */
  mode: CoordinationMode;
  /** Subgraph IDs that must complete before this subgraph can proceed. */
  dependsOn?: string[];
  /** File paths this subgraph owns (other subgraphs must not modify). */
  exports?: string[];
  /** File paths consumed from other subgraphs (this subgraph must not modify). */
  imports?: string[];
  /** Explicit merge sequence number for cross-repo ordering. */
  mergeOrder?: number;
}

/**
 * How a subgraph determines its overall completion status.
 */
export enum SubgraphCompletionPolicy {
  /** Subgraph completes when every member node reaches DONE/MERGED. (Default) */
  ALL = "ALL",
  /** Subgraph completes as soon as any member node reaches DONE/MERGED. */
  ANY = "ANY",
  /** Subgraph completes when every node listed in `gates` reaches DONE/MERGED. */
  GATED = "GATED",
}

/**
 * How node failures within a subgraph propagate to subgraph status.
 */
export enum SubgraphFailurePolicy {
  /** Any node failure marks the subgraph as failed. (Default) */
  FAIL_FAST = "FAIL_FAST",
  /** Other nodes proceed; subgraph fails only if every node fails. */
  CONTINUE = "CONTINUE",
  /** Subgraph completes despite failures, provided every gate node succeeds. */
  BEST_EFFORT = "BEST_EFFORT",
}

/**
 * A reference to a gating condition for a subgraph.
 *
 * Two flavors:
 * - **Node gate** (string): a node ID within the subgraph. The gate clears when
 *   the node reaches a terminal-OK status (DONE/MERGED/PR_CREATED).
 * - **External gate** (object): an external blocker tracked outside trimatrix
 *   (typically a brain task with first-class external blockers — see UNM-1b7.7).
 *   The gate clears when the external system reports the blocker resolved.
 *
 * The polymorphism exists so `GATED` completion and `BEST_EFFORT` failure
 * policies can express "this subgraph is gated on an upstream PR / Jira
 * ticket" without forcing a node into the graph just to represent the
 * blocker.
 */
export type SubgraphGate =
  | string
  | {
    /** Discriminator — always `"external"` for object-form gates. */
    kind: "external";
    /** Source system (e.g., `"jira"`, `"github-pr"`, `"linear"`). */
    source: string;
    /** Identifier within the source system. */
    externalId: string;
    /** Optional URL for human navigation. */
    url?: string;
    /** Optional brain task ID this external blocker is associated with. */
    taskId?: string;
  };

/**
 * A partition of the supergraph assigned to a specific executor.
 * Contains an ordered list of nodes forming the executor's strict traversal contract.
 *
 * Subgraphs may be **derived** (auto-computed from connectivity by `computeSubgraphs`)
 * or **explicit** (declared by the caller via the `add_subgraph` tool).
 * Derived subgraphs use stable hash-based IDs so node addition/removal does not
 * renumber siblings; explicit subgraphs use the user-supplied slug as their ID.
 *
 * Explicit subgraphs are **immutable post-creation**. To revise structure, cancel
 * the session or refine the graph and re-declare. There is no `update_subgraph`
 * or `remove_subgraph` tool by design — mutation invariants are easier to reason
 * about when the structural primitive is append-only within a session.
 */
export interface Subgraph {
  /**
   * Stable subgraph identifier.
   * - `sg-lead` for the lead subgraph (always reserved).
   * - `auto-<8-char hash>` for derived adjunct subgraphs — hash of sorted node IDs.
   * - User-supplied slug for explicit subgraphs.
   */
  id: string;
  /** Optional human-readable label. Auto-derived subgraphs may omit this. */
  label?: string;
  /** Parent subgraph ID for hierarchical nesting. Top-level subgraphs leave this unset. */
  parentId?: string;
  /** True if produced by `computeSubgraphs`; false if declared via `add_subgraph`. */
  derived: boolean;
  /** Node IDs in topological traversal order within this subgraph. */
  nodes: string[];
  /** Edges that exist entirely within this subgraph. */
  edges: Edge[];
  /** Adjunct designation or "LEAD" for the lead session. */
  assignee: string;
  /** Who executes this subgraph's nodes. */
  executor: Executor;
  /** Execution tier governing resource allocation. */
  tier: Tier;
  /** Coordination rules for multi-subgraph execution. */
  coordination: CoordinationContract;
  /** How the subgraph evaluates overall completion. */
  completionPolicy: SubgraphCompletionPolicy;
  /** How node failures propagate to subgraph status. */
  failurePolicy: SubgraphFailurePolicy;
  /** Gate references required by `GATED` completion or `BEST_EFFORT` failure policies.
   * Each entry is either a node ID (string) or an external gate descriptor object. */
  gates?: SubgraphGate[];
}

/**
 * Projection of a `Subgraph` returned by MCP tool responses.
 *
 * This is the contract callers depend on; adding a field here is a public-API
 * change. Internal-only fields (raw `edges`, raw nodes for hashing) are
 * deliberately omitted to keep response payloads compact and the surface stable.
 */
export interface SubgraphSummary {
  id: string;
  derived: boolean;
  executor: Executor;
  tier: Tier;
  assignee: string;
  nodeCount: number;
  nodes: string[];
  coordination: CoordinationContract;
  completionPolicy: SubgraphCompletionPolicy;
  failurePolicy: SubgraphFailurePolicy;
  /** Computed by `subgraphOutcome` against current node statuses. */
  outcome: "pending" | "active" | "completed" | "failed";
  label?: string;
  parentId?: string;
  gates?: SubgraphGate[];
}

// ---------------------------------------------------------------------------
// Lease fencing types (UNM-1b7.6)
// ---------------------------------------------------------------------------

/**
 * Issued to whichever actor (lead session or adjunct) is currently authorized
 * to write completion/failure for a node. Every write to a node must echo
 * both `attemptId` and `leaseVersion`; stale fences are rejected.
 *
 * Lifecycle:
 * - `dispatch_wave` mints a fresh WorkPacket per activated node and returns
 *   them in the response.
 * - `complete_node` / `fail_node` / `update_node` accept a WorkPacket and
 *   reject if it does not match the node's current `attemptId` + `leaseVersion`.
 * - `refine` and `cancel` increment `leaseVersion` on every affected node,
 *   invalidating any in-flight WorkPacket for those nodes.
 */
export interface WorkPacket {
  nodeId: string;
  attemptId: string;
  leaseVersion: number;
}

// ---------------------------------------------------------------------------
// Wave types
// ---------------------------------------------------------------------------

/**
 * A group of nodes that can be executed in parallel within the same wave.
 */
export interface Wave {
  /** Sequential wave index (0-based). */
  id: number;
  /** Node IDs included in this wave. */
  nodes: string[];
  /**
   * When true, execution halts after this wave completes and waits for
   * explicit merge confirmation before proceeding to the next wave.
   * Covers both MERGE_GATE and DEPENDS_ON edges.
   */
  hasMergeGate: boolean;
}

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

/**
 * Top-level states of the trimatrix execution state machine.
 */
export enum MachineState {
  INITIALIZING = "initializing",
  PLAN_REVIEW = "plan_review",
  DISPATCHING = "dispatching",
  GATE_HALTED = "gate_halted",
  REFINING = "refining",
  FAILED = "failed",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
}

/**
 * A single entry in the checkpoint event log.
 * Appended by `appendEvent` and used by `replay` for crash-recovery.
 */
export interface EventLogEntry {
  /** Monotonic sequence number per session (1-based, gapless). */
  seq: number;
  /** ISO 8601 timestamp when this entry was written. */
  timestamp: string;
  /** The event that was applied. */
  event: Event;
  /** Runtime VERSION string at write time (for forward-compat). */
  checkpointVersion: string;
}

/**
 * Persisted checkpoint capturing the full state of a trimatrix execution.
 * Saved to brain snapshots to survive process restarts.
 */
export interface Checkpoint {
  /** Schema version string for forward compatibility (e.g., "1.0.0"). */
  version: string;
  /** Current state of the execution state machine. */
  machineState: MachineState;
  /** The full execution graph. */
  graph: Graph;
  /** Ordered list of waves derived from the graph. */
  waves: Wave[];
  /** ID of the wave currently being executed, or null if none is active. */
  currentWaveId: number | null;
  /** Metadata about each repository involved in this execution. */
  repos: RepoMetadata[];
  /** Historical results of all waves that have completed. */
  waveHistory: WaveResult[];
  /** ISO 8601 timestamp when this checkpoint was first created. */
  createdAt: string;
  /** ISO 8601 timestamp when this checkpoint was last updated. */
  updatedAt: string;
  /** Brain task ID of the epic task for this trimatrix execution, if materialized. */
  epicTaskId?: string;
  /** History of plan refinements applied after initial dispatch. */
  refinementHistory: Array<{
    /** ISO 8601 timestamp when this refinement was applied. */
    timestamp: string;
    /** Node IDs added during this refinement. */
    addedNodes: string[];
    /** Edges added during this refinement. */
    addedEdges: Array<{ from: string; to: string; type: EdgeType }>;
    /** Repository names added during this refinement. */
    addedRepos: string[];
  }>;
  /** Brain session ID of the Claude session that owns this execution, if tracked. */
  sessionId?: string;
  /** Human-readable label for the owning session, if provided. */
  sessionLabel?: string;
  /** Human-readable reason this execution was cancelled, if applicable. */
  cancellationReason?: string;
  /** ISO 8601 timestamp when this execution was cancelled, if applicable. */
  cancelledAt?: string;
  /** Classified intent for this execution. */
  intent?: Intent;
  /** Complexity tier governing execution strategy. */
  tier?: Tier;
  /** Strategy used to partition the supergraph into subgraphs. */
  subgraphStrategy?: SubgraphStrategy;
  /** Computed subgraph partitions. */
  subgraphs?: Subgraph[];
  /** Episode summary_ids written during this session (episodic memory). */
  episodeIds?: string[];
  /** Routing decision captured at classification time. */
  routingTrace?: RoutingTrace;
  /**
   * Append-only event log for crash-recovery replay.
   * Populated by `appendEvent`; absent (or empty) on pre-2.6.0 checkpoints.
   * Invariant: `replay(eventLog)` reproduces the materialized checkpoint.
   */
  eventLog?: EventLogEntry[];
}

// ---------------------------------------------------------------------------
// Repository metadata
// ---------------------------------------------------------------------------

/**
 * Metadata about a single repository participating in the trimatrix execution.
 */
export interface RepoMetadata {
  /** Brain name for this repository. */
  name: string;
  /** Absolute filesystem path to the repository root. */
  root: string;
  /** All worktrees managed by trimatrix within this repository. */
  worktrees: WorktreeInfo[];
}

/**
 * Information about a single git worktree managed by trimatrix.
 */
export interface WorktreeInfo {
  /** Branch name checked out in this worktree. */
  branch: string;
  /** Absolute filesystem path to the worktree, if it has been created on disk. */
  path?: string;
  /** Branch name this worktree is stacked on, if applicable. */
  stackedOn?: string;
  /** The node ID this worktree corresponds to. */
  nodeId: string;
}

// ---------------------------------------------------------------------------
// Wave results
// ---------------------------------------------------------------------------

/**
 * Result summary for a completed (or failed) wave.
 */
export enum WaveResultStatus {
  COMPLETED = "completed",
  PARTIAL_FAILURE = "partial_failure",
  FAILED = "failed",
}

export interface WaveResult {
  /** ID of the wave this result corresponds to. */
  waveId: number;
  /** Aggregate outcome of the wave. */
  status: WaveResultStatus;
  /** Node IDs that completed successfully within this wave. */
  completedNodes: string[];
  /** Node IDs that failed within this wave. */
  failedNodes: string[];
  /** Pull requests created during this wave. */
  prs: PrInfo[];
}

/**
 * Information about a pull request created during trimatrix execution.
 */
export interface PrInfo {
  /** The node ID this PR was created for. */
  nodeId: string;
  /** Brain name of the repository this PR targets. */
  repo: string;
  /** Full URL of the pull request. */
  url: string;
  /** Pull request number within the repository. */
  number: number;
  /** Base branch the PR targets. */
  base: string;
  /** Whether this PR has been merged. */
  merged: boolean;
}

// ---------------------------------------------------------------------------
// Episodic memory types
// ---------------------------------------------------------------------------

/**
 * Compact stub returned by brain's memory_search_minimal for episode results.
 */
export interface EpisodeStub {
  /** Brain summary_id (ULID). */
  summary_id: string;
  /** Episode title (goal text). */
  title: string;
  /** Tags attached to the episode. */
  tags: string[];
  /** Relevance score from search (0–1). */
  score?: number;
}

// ---------------------------------------------------------------------------
// Elicitation types
// ---------------------------------------------------------------------------

/**
 * A single primitive property within an elicitation schema.
 * MCP elicitation restricts schemas to flat objects with primitive fields only.
 */
export type ElicitationProperty =
  | {
    type: "string";
    title?: string;
    description?: string;
    minLength?: number;
    maxLength?: number;
    format?: string;
  }
  | {
    type: "number" | "integer";
    title?: string;
    description?: string;
    minimum?: number;
    maximum?: number;
  }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | {
    type: "string";
    enum: string[];
    enumNames?: string[];
    title?: string;
    description?: string;
  };

/**
 * The requestedSchema parameter for MCP elicitation/create.
 * Must be a flat JSON Schema object — no nested objects, no arrays of objects.
 */
export interface ElicitationRequestedSchema {
  type: "object";
  properties: Record<string, ElicitationProperty>;
  required?: string[];
}

/**
 * Result returned by an MCP elicitation/create request.
 * - `accept`: user submitted data; `content` holds the form values.
 * - `decline`: user explicitly rejected the form.
 * - `cancel`: user dismissed without choosing.
 */
export type ElicitResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

// ---------------------------------------------------------------------------
// Elicitation schema builders
// ---------------------------------------------------------------------------

/**
 * Schema for an approval form.
 * Presents a boolean approval field and an optional free-text modifications field.
 */
export function approvalSchema(opts?: {
  approveTitle?: string;
  modificationsTitle?: string;
}): ElicitationRequestedSchema {
  return {
    type: "object",
    properties: {
      approve: {
        type: "boolean",
        title: opts?.approveTitle ?? "Approve",
        description: "Approve this action to proceed.",
        default: false,
      },
      modifications: {
        type: "string",
        title: opts?.modificationsTitle ?? "Requested modifications",
        description:
          "Optional: describe any modifications before proceeding.",
      },
    },
    required: ["approve"],
  };
}

/**
 * Schema for a triage form.
 * Presents a decision enum (retry / diagnose / abandon) and an optional context field.
 */
export function triageSchema(opts?: {
  decisionTitle?: string;
  contextTitle?: string;
}): ElicitationRequestedSchema {
  return {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["retry", "diagnose", "abandon"],
        enumNames: ["Retry", "Diagnose", "Abandon"],
        title: opts?.decisionTitle ?? "Decision",
        description: "How to proceed after this failure.",
      },
      context: {
        type: "string",
        title: opts?.contextTitle ?? "Additional context",
        description:
          "Optional: provide additional context for the decision.",
      },
    },
    required: ["decision"],
  };
}

/**
 * Schema for a generic selection form.
 * Presents an enum selection field and an optional free-text notes field.
 *
 * @param choices - Array of option values to present.
 * @param opts.choiceNames - Optional human-readable labels for each option.
 */
export function selectionSchema(
  choices: string[],
  opts?: {
    choiceNames?: string[];
    selectionTitle?: string;
    notesTitle?: string;
  },
): ElicitationRequestedSchema {
  return {
    type: "object",
    properties: {
      selection: {
        type: "string",
        enum: choices,
        ...(opts?.choiceNames ? { enumNames: opts.choiceNames } : {}),
        title: opts?.selectionTitle ?? "Selection",
        description: "Choose one of the available options.",
      },
      notes: {
        type: "string",
        title: opts?.notesTitle ?? "Notes",
        description: "Optional: provide any additional notes.",
      },
    },
    required: ["selection"],
  };
}

// ---------------------------------------------------------------------------
// Events (state machine transitions)
// ---------------------------------------------------------------------------

/**
 * Union of all events that drive state machine transitions in trimatrix.
 */
export type Event =
  | { type: "plan_submitted" }
  | { type: "plan_finalized" }
  | { type: "plan_revision_requested" }
  | { type: "wave_dispatched"; waveId: number }
  | { type: "node_completed"; nodeId: string }
  | { type: "node_failed"; nodeId: string; reason: string }
  | { type: "gate_cleared"; nodeId: string; response?: Record<string, unknown> }
  | { type: "wave_completed"; waveId: number }
  | { type: "wave_failed"; waveId: number }
  | { type: "execution_completed" }
  | { type: "retry_wave"; waveId: number }
  | {
    type: "review_passed";
    nodeId: string;
    reviewVerdict?: "PASS";
    reviewNotes?: string;
  }
  | {
    type: "review_failed";
    nodeId: string;
    reviewVerdict?: "FAIL";
    reviewNotes?: string;
  }
  | { type: "refine" }
  | { type: "refinement_approved" }
  | { type: "subgraph_added"; subgraph: Subgraph }
  | { type: "cancel"; reason?: string }
  | {
    type: "node_reset";
    nodeId: string;
    /** Optional human-readable reason for the reset (preserved in event log). */
    reason?: string;
    /** If true, resets iterationCount to 0. Otherwise preserves the current count. */
    resetIterationCount?: boolean;
  };
