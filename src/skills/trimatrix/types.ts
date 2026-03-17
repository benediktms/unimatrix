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
  BLOCKED = "BLOCKED",
  FAILED = "FAILED",
  DONE = "DONE",
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
  /** Markdown prompt/context to present to the user during elicitation. Only for ELICIT_GATE nodes. */
  elicitPrompt?: string;
  /** JSON Schema for the elicitation form. Only for ELICIT_GATE nodes. Defaults to approval schema if omitted. */
  elicitSchema?: ElicitationRequestedSchema;
  /** User's structured response after elicitation completes. Populated by clear_gate. */
  elicitResponse?: Record<string, unknown>;
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
 * A partition of the supergraph assigned to a specific executor.
 * Contains an ordered list of nodes forming the executor's strict traversal contract.
 */
export interface Subgraph {
  /** Unique subgraph identifier (e.g., "sg-lead", "sg-1"). */
  id: string;
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
  | {
    type: "node_completed";
    nodeId: string;
    prUrl?: string;
    prNumber?: number;
  }
  | { type: "node_failed"; nodeId: string; reason: string }
  | { type: "gate_cleared"; nodeId: string; response?: Record<string, unknown> }
  | { type: "wave_completed"; waveId: number }
  | { type: "wave_failed"; waveId: number }
  | { type: "execution_completed" }
  | { type: "retry_wave"; waveId: number }
  | { type: "refine" }
  | { type: "refinement_approved" }
  | { type: "cancel"; reason?: string };
