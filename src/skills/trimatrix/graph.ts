/**
 * Pure DAG computation engine for the trimatrix cross-repository orchestration system.
 *
 * Provides topological sort, wave computation, gate management, cycle detection,
 * and node state mutation — all as pure functions returning new graph copies.
 */

import type {
  Capabilities,
  CoordinationContract,
  Edge,
  FrontierEntry,
  Graph,
  Node,
  Requirements,
  Subgraph,
  SubgraphGate,
  Wave,
} from "./types.ts";
import {
  CoordinationMode,
  EdgeType,
  Executor,
  NodeStatus,
  NodeType,
  ReadinessStatus,
  SubgraphCompletionPolicy,
  SubgraphFailurePolicy,
  SubgraphStrategy,
  Tier,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Algorithm version
// ---------------------------------------------------------------------------

/**
 * Monotonically increasing version string for cached deterministic
 * computations (wave layout, subgraph partitioning, frontier computation).
 * Bump when the algorithm changes to invalidate cached results stored in
 * Checkpoint.algorithmVersion comparisons.
 */
export const GRAPH_ALGORITHM_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Refinement mutation result
// ---------------------------------------------------------------------------

export interface MutationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// close_node guard
// ---------------------------------------------------------------------------

/**
 * Validate that a node is in a state where its brain task can be closed.
 *
 * Pure function — extracted from the `close_node` MCP handler so tests can
 * exercise the actual guard logic without reimplementing it. Production code
 * and tests must converge on this single source of truth.
 *
 * Returns:
 * - `{ ok: true }` if `node` exists, has a `taskId`, and is in DONE / MERGED /
 *   PR_CREATED status.
 * - `{ ok: false, error }` otherwise, with a caller-meaningful error message.
 */
export function closeNodeGuard(
  node: Node | undefined,
  nodeId: string,
): { ok: true } | { ok: false; error: string } {
  if (!node) {
    return { ok: false, error: `Node "${nodeId}" not found in graph` };
  }
  if (!node.taskId) {
    return {
      ok: false,
      error: `Node "${nodeId}" has no associated taskId — cannot close`,
    };
  }
  const completedStatuses: NodeStatus[] = [
    NodeStatus.DONE,
    NodeStatus.MERGED,
    NodeStatus.PR_CREATED,
  ];
  if (!completedStatuses.includes(node.status)) {
    return {
      ok: false,
      error:
        `Node "${nodeId}" is in status ${node.status} — must be DONE, MERGED, or PR_CREATED to close`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Capability matching
// ---------------------------------------------------------------------------

/**
 * Determine whether a dispatcher's capabilities satisfy a node's requirements.
 *
 * Subset semantics:
 * - Every required `repos[]` entry must appear in `capabilities.repos`, or
 *   `capabilities.repos` must include `"*"` (write-anywhere).
 * - Every required `tools[]` entry must appear in `capabilities.tools`.
 * - If `requirements.canWrite` is true, `capabilities.canWrite` must be true.
 * - If `requirements.humanPresent` is true, `capabilities.humanPresent` must be true.
 * - Every required `labels[]` entry must appear in `capabilities.labels`.
 *
 * Returns `{ ok: true }` when all requirements are met, or
 * `{ ok: false, missing: [...] }` with concrete unmet items
 * (e.g. `"repo:foo"`, `"tool:bash"`, `"canWrite"`, `"humanPresent"`, `"label:urgent"`).
 */
export function canDispatch(
  capabilities: Capabilities,
  requirements: Requirements | undefined,
): { ok: true } | { ok: false; missing: string[] } {
  if (!requirements) return { ok: true };

  const missing: string[] = [];

  if (requirements.repos && requirements.repos.length > 0) {
    const capRepos = capabilities.repos ?? [];
    const wildcard = capRepos.includes("*");
    for (const repo of requirements.repos) {
      if (!wildcard && !capRepos.includes(repo)) {
        missing.push(`repo:${repo}`);
      }
    }
  }

  if (requirements.tools && requirements.tools.length > 0) {
    const capTools = capabilities.tools ?? [];
    for (const tool of requirements.tools) {
      if (!capTools.includes(tool)) {
        missing.push(`tool:${tool}`);
      }
    }
  }

  if (requirements.canWrite === true && !capabilities.canWrite) {
    missing.push("canWrite");
  }

  if (requirements.humanPresent === true && !capabilities.humanPresent) {
    missing.push("humanPresent");
  }

  if (requirements.labels && requirements.labels.length > 0) {
    const capLabels = capabilities.labels ?? [];
    for (const label of requirements.labels) {
      if (!capLabels.includes(label)) {
        missing.push(`label:${label}`);
      }
    }
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/**
 * Validate that the given dispatcher can handle a specific node's requirements.
 *
 * Looks up `nodeId` in the graph, evaluates `canDispatch`, and returns a
 * `MutationResult<void>` with a human-readable error message on mismatch.
 *
 * Does NOT wire into `dispatch_wave` — caller is responsible for integration.
 */
export function validateDispatch(
  graph: Graph,
  nodeId: string,
  capabilities: Capabilities,
): MutationResult<void> {
  const node = graph.nodes[nodeId];
  if (!node) {
    return { ok: false, error: `Node "${nodeId}" not found in graph` };
  }

  const result = canDispatch(capabilities, node.requirements);
  if (result.ok) return { ok: true };

  return {
    ok: false,
    error: `Node ${nodeId} requires ${
      result.missing.join(", ")
    }; dispatcher lacks these capabilities`,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate graph integrity.
 *
 * Checks performed:
 * - All edge `from`/`to` refs point to existing nodes
 * - `stackedOn` refs point to existing nodes and are not self-references
 * - No cycles exist (Kahn's algorithm)
 */
export function validate(graph: Graph): ValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(Object.keys(graph.nodes));

  // Validate edge refs
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge references unknown source node: "${edge.from}"`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge references unknown target node: "${edge.to}"`);
    }
    if (edge.from === edge.to) {
      errors.push(`Self-referencing edge detected on node: "${edge.from}"`);
    }
  }

  // Validate ELICIT_GATE constraints
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type === NodeType.ELICIT_GATE) {
      if (node.executor !== Executor.LEAD) {
        errors.push(
          `ELICIT_GATE node "${id}" must have executor LEAD, got ${node.executor}`,
        );
      }
      if (!node.elicitPrompt) {
        errors.push(
          `ELICIT_GATE node "${id}" is missing elicitPrompt`,
        );
      }
    }
  }

  // Validate stackedOn refs
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.stackedOn !== undefined) {
      if (node.stackedOn === id) {
        errors.push(`Node "${id}" has stackedOn pointing to itself`);
      } else if (!nodeIds.has(node.stackedOn)) {
        errors.push(
          `Node "${id}" stackedOn references unknown node: "${node.stackedOn}"`,
        );
      }
    }
  }

  // Kahn's algorithm — cycle detection
  // Build in-degree map and adjacency list from ALL edges
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const edge of graph.edges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      adj.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }

  // Process queue
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const neighbour of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbour) ?? 0) - 1;
      inDegree.set(neighbour, newDeg);
      if (newDeg === 0) queue.push(neighbour);
    }
  }

  if (processed < nodeIds.size) {
    errors.push(
      "Cycle detected in graph — not a valid DAG",
    );
  }

  // Detect unsatisfiable edges: source node is FAILED
  for (const edge of graph.edges) {
    const source = graph.nodes[edge.from];
    if (source?.status === NodeStatus.FAILED) {
      errors.push(
        `Unsatisfiable: edge ${edge.from} → ${edge.to} (${edge.type}) — source node is FAILED`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Wave computation
// ---------------------------------------------------------------------------

/**
 * Compute ordered waves for the graph via topological level assignment.
 *
 * Rules:
 * - `MERGE_GATE` and `DEPENDS_ON` edges create wave boundaries — the target
 *   node belongs to a later wave than the source.
 * - `STACKED` edges within the same repo do NOT create wave boundaries — the
 *   target node can be in the same wave as the source.
 * - Nodes with no incoming edges start at wave 0.
 * - A wave carries `hasMergeGate = true` when any `MERGE_GATE` or `DEPENDS_ON`
 *   edge points INTO a subsequent wave (i.e., the gate is guarded by this wave's completion).
 */
export function computeWaves(graph: Graph): Wave[] {
  const nodeIds = Object.keys(graph.nodes);
  if (nodeIds.length === 0) return [];

  // Assign topological levels.
  // Only MERGE_GATE and DEPENDS_ON edges advance the wave boundary.
  const level = new Map<string, number>();
  for (const id of nodeIds) {
    level.set(id, 0);
  }

  // Topological order via Kahn's on ALL edges so we process in dependency order
  const inDegreeAll = new Map<string, number>();
  const adjAll = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegreeAll.set(id, 0);
    adjAll.set(id, []);
  }
  for (const edge of graph.edges) {
    if (
      nodeIds.includes(edge.from) && nodeIds.includes(edge.to)
    ) {
      adjAll.get(edge.from)!.push(edge.to);
      inDegreeAll.set(edge.to, (inDegreeAll.get(edge.to) ?? 0) + 1);
    }
  }

  const topoQueue: string[] = [];
  for (const [id, deg] of inDegreeAll) {
    if (deg === 0) topoQueue.push(id);
  }

  const topoOrder: string[] = [];
  const tempQueue = [...topoQueue];
  while (tempQueue.length > 0) {
    const cur = tempQueue.shift()!;
    topoOrder.push(cur);
    for (const nb of adjAll.get(cur) ?? []) {
      const nd = (inDegreeAll.get(nb) ?? 0) - 1;
      inDegreeAll.set(nb, nd);
      if (nd === 0) tempQueue.push(nb);
    }
  }

  // Build edge lookup by (from, to) -> type
  const edgeType = new Map<string, Edge["type"]>();
  for (const edge of graph.edges) {
    edgeType.set(`${edge.from}::${edge.to}`, edge.type);
  }

  // Process nodes in topological order, propagating levels
  for (const id of topoOrder) {
    const curLevel = level.get(id) ?? 0;
    for (const nb of adjAll.get(id) ?? []) {
      const eType = edgeType.get(`${id}::${nb}`);
      const bump =
        (eType === EdgeType.MERGE_GATE || eType === EdgeType.DEPENDS_ON)
          ? 1
          : 0;
      const newLevel = curLevel + bump;
      if (newLevel > (level.get(nb) ?? 0)) {
        level.set(nb, newLevel);
      }
    }
  }

  // Group nodes by level
  const byLevel = new Map<number, string[]>();
  for (const [id, lv] of level) {
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(id);
  }

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

  // Determine which wave IDs have outgoing MERGE_GATE or DEPENDS_ON edges into a later wave
  const gateSourceLevels = new Set<number>();
  for (const edge of graph.edges) {
    if (
      edge.type === EdgeType.MERGE_GATE || edge.type === EdgeType.DEPENDS_ON
    ) {
      const fromLevel = level.get(edge.from) ?? 0;
      gateSourceLevels.add(fromLevel);
    }
  }

  const waves: Wave[] = sortedLevels.map((lv, idx) => ({
    id: idx + 1,
    nodes: byLevel.get(lv) ?? [],
    hasMergeGate: gateSourceLevels.has(lv),
  }));

  return waves;
}

// ---------------------------------------------------------------------------
// Wave progression
// ---------------------------------------------------------------------------

/** Statuses that satisfy a `STACKED` edge dependency. */
const STACKED_SATISFIED: NodeStatus[] = [
  NodeStatus.PR_CREATED,
  NodeStatus.MERGED,
];

/** Status that satisfies a `MERGE_GATE` edge dependency. */
const MERGE_GATE_SATISFIED: NodeStatus = NodeStatus.MERGED;

/** Statuses that satisfy a `DEPENDS_ON` edge dependency. */
const DEPENDS_ON_SATISFIED: NodeStatus[] = [NodeStatus.DONE, NodeStatus.MERGED];

// ---------------------------------------------------------------------------
// Dependency satisfaction check
// ---------------------------------------------------------------------------

export interface UnsatisfiedDependency {
  edge: Edge;
  reason: string;
}

/**
 * Recompute the topology `readinessStatus` for every node in the graph.
 *
 * - A node with no unsatisfied incoming deps becomes `READY`.
 * - A node with at least one unsatisfied incoming dep becomes `BLOCKED`.
 * - Nodes already marked `INVALIDATED` are preserved as-is — invalidation is
 *   set explicitly by refinement code and only cleared by re-dispatch, never
 *   by automatic recompute.
 *
 * This is the topology axis (orthogonal to `NodeStatus`). The execution layer
 * (`compute_waves`, `dispatch_wave`) reads this to decide whether a `PENDING`
 * node is actually claimable.
 *
 * Returns a new `Graph` value — pure function, no mutation.
 */
export function recomputeReadiness(graph: Graph): Graph {
  const updatedNodes: Record<string, Node> = {};
  let changed = false;
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.readinessStatus === ReadinessStatus.INVALIDATED) {
      updatedNodes[id] = node;
      continue;
    }
    const unsatisfied = unsatisfiedDependencies(graph, id);
    const next = unsatisfied.length === 0
      ? ReadinessStatus.READY
      : ReadinessStatus.BLOCKED;

    // Compute the set of FAILED predecessor IDs for failure-isolation tracking.
    // A node is in `blockedBy` only when the source node is currently FAILED.
    const failedPredecessors: string[] = [];
    for (const edge of graph.edges) {
      if (edge.to !== id) continue;
      const source = graph.nodes[edge.from];
      if (source && source.status === NodeStatus.FAILED) {
        failedPredecessors.push(edge.from);
      }
    }
    const prevBlockedBy = node.blockedBy ?? [];
    const blockedByChanged =
      failedPredecessors.length !== prevBlockedBy.length ||
      failedPredecessors.some((fid) => !prevBlockedBy.includes(fid));

    if (node.readinessStatus !== next || blockedByChanged) {
      updatedNodes[id] = {
        ...node,
        readinessStatus: next,
        blockedBy: failedPredecessors.length > 0
          ? failedPredecessors
          : undefined,
      };
      changed = true;
    } else {
      updatedNodes[id] = node;
    }
  }
  if (!changed) return graph;
  return { ...graph, nodes: updatedNodes };
}

/**
 * Return all unsatisfied incoming dependencies for a node.
 * Empty array means all dependencies are satisfied.
 */
export function unsatisfiedDependencies(
  graph: Graph,
  nodeId: string,
): UnsatisfiedDependency[] {
  const result: UnsatisfiedDependency[] = [];
  for (const edge of graph.edges) {
    if (edge.to !== nodeId) continue;
    const source = graph.nodes[edge.from];
    if (!source) {
      result.push({ edge, reason: `source node "${edge.from}" not found` });
      continue;
    }
    if (edge.type === EdgeType.DEPENDS_ON) {
      if (!DEPENDS_ON_SATISFIED.includes(source.status)) {
        result.push({
          edge,
          reason: `source is ${source.status}, requires DONE or MERGED`,
        });
      }
    } else if (edge.type === EdgeType.MERGE_GATE) {
      if (source.status !== MERGE_GATE_SATISFIED) {
        result.push({
          edge,
          reason: `source is ${source.status}, requires MERGED`,
        });
      } else if (!source.prUrl) {
        result.push({ edge, reason: `source is MERGED but lacks prUrl` });
      }
    } else {
      // STACKED
      if (!STACKED_SATISFIED.includes(source.status)) {
        result.push({
          edge,
          reason: `source is ${source.status}, requires PR_CREATED or MERGED`,
        });
      }
    }
  }
  return result;
}

/**
 * Returns the next wave ready for execution, or null if none is available.
 *
 * A wave is ready when all upstream dependencies are satisfied:
 * - `MERGE_GATE` edges: source node must be MERGED
 * - `STACKED` edges: source node must be PR_CREATED or later
 * - `DEPENDS_ON` edges: source node must be DONE or MERGED
 *
 * Returns null when:
 * - The machine is gate_halted (caller is responsible for detecting this)
 * - All waves have been completed
 * - No wave has all its dependencies satisfied yet
 */
export function nextWave(
  graph: Graph,
  waves: Wave[],
  currentWaveId: number | null,
): Wave | null {
  if (waves.length === 0) return null;

  // Determine which waves are already done
  const completedWaveIds = new Set<number>();
  for (const wave of waves) {
    const allDone = wave.nodes.every(
      (nId) => {
        const s = graph.nodes[nId]?.status;
        return s === NodeStatus.MERGED || s === NodeStatus.DONE;
      },
    );
    if (allDone) completedWaveIds.add(wave.id);
  }

  for (const wave of waves) {
    // Skip already-completed waves
    if (completedWaveIds.has(wave.id)) continue;
    // Skip the currently active wave
    if (currentWaveId !== null && wave.id === currentWaveId) continue;
    // Only look at waves after the current one
    if (currentWaveId !== null && wave.id <= currentWaveId) continue;

    // Check all nodes in this wave: do their dependencies allow activation?
    // Intra-wave edges are skipped — they sequence execution within the wave,
    // not block the wave from being dispatched.
    const waveNodeIds = new Set(wave.nodes);
    const waveReady = wave.nodes.every((nId) => {
      const unsatisfied = unsatisfiedDependencies(graph, nId);
      // Filter out intra-wave deps — they sequence within the wave, not block dispatch
      return unsatisfied.every((u) => waveNodeIds.has(u.edge.from));
    });

    if (waveReady) return wave;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Graph mutation helpers (pure — return new copies)
// ---------------------------------------------------------------------------

/**
 * Clear the merge gate on a node: transition from BLOCKED back to ACTIVE
 * so the wave can proceed past the gate.
 */
export function clearGate(graph: Graph, nodeId: string): Graph {
  const node = graph.nodes[nodeId];
  if (!node) return graph;
  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      [nodeId]: {
        ...node,
        status: NodeStatus.ACTIVE,
        failureReason: undefined,
      },
    },
  };
}

/**
 * Mark a node as completed.
 * - If node already has prUrl: status becomes PR_CREATED.
 * - Without prUrl and node has repo: status becomes MERGED.
 * - Without prUrl and no repo (single-repo): status becomes DONE.
 */
export function completeNode(
  graph: Graph,
  nodeId: string,
): Graph {
  const node = graph.nodes[nodeId];
  if (!node) return graph;
  const updated: Node = {
    ...node,
    status: node.prUrl
      ? NodeStatus.PR_CREATED
      : (node.repo ? NodeStatus.MERGED : NodeStatus.DONE),
  };
  return {
    ...graph,
    nodes: { ...graph.nodes, [nodeId]: updated },
  };
}

/**
 * Update metadata on a node without changing its status.
 * Patches prUrl and/or prNumber onto an existing node.
 * Throws if the node does not exist.
 */
export function updateNode(
  graph: Graph,
  nodeId: string,
  patch: { prUrl?: string; prNumber?: number },
): Graph {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`Node "${nodeId}" not found`);
  const updated: Node = {
    ...node,
    ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
    ...(patch.prNumber !== undefined ? { prNumber: patch.prNumber } : {}),
  };
  return {
    ...graph,
    nodes: { ...graph.nodes, [nodeId]: updated },
  };
}

/**
 * Mark a node as failed with a human-readable reason.
 */
export function failNode(
  graph: Graph,
  nodeId: string,
  reason: string,
): Graph {
  const node = graph.nodes[nodeId];
  if (!node) return graph;
  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      [nodeId]: { ...node, status: NodeStatus.FAILED, failureReason: reason },
    },
  };
}

/**
 * Transition a set of nodes to ACTIVE status.
 */
export function activateNodes(graph: Graph, nodeIds: string[]): Graph {
  const updatedNodes = { ...graph.nodes };
  for (const id of nodeIds) {
    if (updatedNodes[id]) {
      updatedNodes[id] = { ...updatedNodes[id], status: NodeStatus.ACTIVE };
    }
  }
  return { ...graph, nodes: updatedNodes };
}

// ---------------------------------------------------------------------------
// Refinement-aware graph mutations
// ---------------------------------------------------------------------------

/** Node statuses that indicate the node has been completed or is actively running. */
const ACTIVE_OR_COMPLETED_STATUSES: NodeStatus[] = [
  NodeStatus.ACTIVE,
  NodeStatus.PR_CREATED,
  NodeStatus.MERGED,
];

/**
 * Add a node to the graph with refinement-mode guards.
 *
 * When `refining` is true:
 * - The node's `stackedOn` target must not be an active or completed node
 *   (new nodes cannot be inserted into completed/active waves).
 *
 * When `refining` is false, the node is accepted unconditionally (validation
 * is deferred to `validate()` / `computeWaves()`).
 */
export function addNode(
  graph: Graph,
  node: Node,
  refining = false,
): MutationResult<Graph> {
  if (refining && graph.nodes[node.id] !== undefined) {
    return {
      ok: false,
      error:
        `Cannot add node during refinement: ID "${node.id}" already exists`,
    };
  }

  if (refining && node.stackedOn !== undefined) {
    const parent = graph.nodes[node.stackedOn];
    if (parent && ACTIVE_OR_COMPLETED_STATUSES.includes(parent.status)) {
      return {
        ok: false,
        error:
          `Cannot add node "${node.id}" stacked on "${node.stackedOn}" — that node is ${parent.status} and belongs to a completed or active wave`,
      };
    }
  }

  // Backfill readinessStatus default for callers that haven't migrated to
  // the 2.5.0 schema yet (`undefined` → `READY`). The next `recomputeReadiness`
  // pass corrects it based on actual edge satisfaction.
  const nodeWithReadiness: Node = node.readinessStatus !== undefined
    ? node
    : { ...node, readinessStatus: ReadinessStatus.READY };

  // Backfill iteration-tracking defaults introduced in 2.7.0. Fresh nodes that
  // do not supply these fields start at 0 / 3 respectively. Mirror the pattern
  // used above for readinessStatus so the graph always has coherent defaults.
  const nodeWithIterations: Node = {
    ...nodeWithReadiness,
    iterationCount: nodeWithReadiness.iterationCount ?? 0,
    maxIterations: nodeWithReadiness.maxIterations ?? 3,
  };

  return {
    ok: true,
    value: {
      ...graph,
      nodes: { ...graph.nodes, [node.id]: nodeWithIterations },
    },
  };
}

/**
 * Add an edge to the graph with refinement-mode guards.
 *
 * When `refining` is true:
 * - The `to` node must not be an active or completed node (adding an incoming
 *   dependency to already-dispatched work is forbidden).
 *
 * When `refining` is false, the edge is accepted unconditionally.
 */
export function addEdge(
  graph: Graph,
  edge: Edge,
  refining = false,
): MutationResult<Graph> {
  if (refining) {
    const target = graph.nodes[edge.to];
    if (target && ACTIVE_OR_COMPLETED_STATUSES.includes(target.status)) {
      return {
        ok: false,
        error:
          `Cannot add edge to "${edge.to}" — that node is ${target.status} (active or completed)`,
      };
    }
  }

  return {
    ok: true,
    value: {
      ...graph,
      edges: [...graph.edges, edge],
    },
  };
}

/**
 * Compute waves for a graph that is being refined mid-execution.
 *
 * Rules:
 * - Completed nodes (status MERGED or DONE) are excluded from the topological sort.
 * - Edges whose `from` node is completed are treated as pre-satisfied (not a
 *   blocking dependency for the receiving node).
 * - New waves are numbered starting after `waveOffset` so they do not
 *   collide with already-assigned completed wave numbers.
 *
 * Returns only the new/modified waves. The caller merges them with the
 * existing completed waves.
 */
export function computeWavesFromRefinement(
  graph: Graph,
  waveOffset: number,
): Wave[] {
  const completedStatuses: NodeStatus[] = [NodeStatus.MERGED, NodeStatus.DONE];

  // Identify completed node IDs — excluded from the new computation
  const completedNodeIds = new Set(
    Object.entries(graph.nodes)
      .filter(([, n]) => completedStatuses.includes(n.status))
      .map(([id]) => id),
  );

  // Remaining nodes to assign to new waves
  const remainingNodeIds = Object.keys(graph.nodes).filter(
    (id) => !completedNodeIds.has(id),
  );

  if (remainingNodeIds.length === 0) return [];

  // Filter edges: keep only those whose both endpoints are remaining nodes,
  // OR whose `from` is a completed node (treated as pre-satisfied — excluded
  // from in-degree computation so remaining nodes start at level 0 if their
  // only deps are completed).
  const activeEdges = graph.edges.filter(
    (e) => !completedNodeIds.has(e.from) && !completedNodeIds.has(e.to),
  );

  // Assign topological levels for remaining nodes only.
  const level = new Map<string, number>();
  for (const id of remainingNodeIds) {
    level.set(id, 0);
  }

  // Build adjacency and in-degree for remaining nodes only
  const inDegreeAll = new Map<string, number>();
  const adjAll = new Map<string, string[]>();
  for (const id of remainingNodeIds) {
    inDegreeAll.set(id, 0);
    adjAll.set(id, []);
  }
  for (const edge of activeEdges) {
    adjAll.get(edge.from)!.push(edge.to);
    inDegreeAll.set(edge.to, (inDegreeAll.get(edge.to) ?? 0) + 1);
  }

  // Topological sort
  const tempQueue: string[] = [];
  for (const [id, deg] of inDegreeAll) {
    if (deg === 0) tempQueue.push(id);
  }

  const topoOrder: string[] = [];
  const queue = [...tempQueue];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topoOrder.push(cur);
    for (const nb of adjAll.get(cur) ?? []) {
      const nd = (inDegreeAll.get(nb) ?? 0) - 1;
      inDegreeAll.set(nb, nd);
      if (nd === 0) queue.push(nb);
    }
  }

  // Build edge type lookup
  const edgeType = new Map<string, Edge["type"]>();
  for (const edge of activeEdges) {
    edgeType.set(`${edge.from}::${edge.to}`, edge.type);
  }

  // Propagate levels
  for (const id of topoOrder) {
    const curLevel = level.get(id) ?? 0;
    for (const nb of adjAll.get(id) ?? []) {
      const eType = edgeType.get(`${id}::${nb}`);
      const bump =
        (eType === EdgeType.MERGE_GATE || eType === EdgeType.DEPENDS_ON)
          ? 1
          : 0;
      const newLevel = curLevel + bump;
      if (newLevel > (level.get(nb) ?? 0)) {
        level.set(nb, newLevel);
      }
    }
  }

  // Group remaining nodes by level
  const byLevel = new Map<number, string[]>();
  for (const [id, lv] of level) {
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(id);
  }

  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

  // Determine wave IDs with outgoing MERGE_GATE or DEPENDS_ON edges into later waves
  const gateSourceLevels = new Set<number>();
  for (const edge of activeEdges) {
    if (
      edge.type === EdgeType.MERGE_GATE || edge.type === EdgeType.DEPENDS_ON
    ) {
      const fromLevel = level.get(edge.from) ?? 0;
      gateSourceLevels.add(fromLevel);
    }
  }

  // Build new waves, numbering from waveOffset + 1
  const waves: Wave[] = sortedLevels.map((lv, idx) => ({
    id: waveOffset + idx + 1,
    nodes: byLevel.get(lv) ?? [],
    hasMergeGate: gateSourceLevels.has(lv),
  }));

  return waves;
}

// ---------------------------------------------------------------------------
// Wave status
// ---------------------------------------------------------------------------

/**
 * Aggregate status of a wave based on its constituent node statuses.
 *
 * - "completed"       — all nodes are MERGED or DONE
 * - "failed"          — all nodes failed or blocked
 * - "partial_failure" — some nodes failed/blocked, at least one completed
 * - "active"          — at least one node is active (and none failed yet)
 * - "pending"         — all nodes are still pending
 */
export function waveStatus(
  graph: Graph,
  wave: Wave,
): "pending" | "active" | "completed" | "partial_failure" | "failed" {
  if (wave.nodes.length === 0) return "completed";

  const statuses = wave.nodes.map((id) =>
    graph.nodes[id]?.status ?? NodeStatus.PENDING
  );

  const allTerminal = statuses.every((s) =>
    s === NodeStatus.MERGED || s === NodeStatus.DONE
  );
  if (allTerminal) return "completed";

  // NodeStatus.BLOCKED is reserved for ELICIT_GATE nodes awaiting elicitation —
  // they are pending, not failed. Only FAILED is terminal-not-OK here.
  const isFailed = (s: NodeStatus | undefined) => s === NodeStatus.FAILED;
  const allFailed = statuses.every(isFailed);
  if (allFailed) return "failed";

  const hasFailure = statuses.some(isFailed);
  const hasCompleted = statuses.some(
    (s) =>
      s === NodeStatus.MERGED || s === NodeStatus.PR_CREATED ||
      s === NodeStatus.DONE,
  );
  if (hasFailure && hasCompleted) return "partial_failure";
  if (hasFailure) return "failed";

  const hasActive = statuses.some((s) => s === NodeStatus.ACTIVE);
  if (hasActive) return "active";

  return "pending";
}

// ---------------------------------------------------------------------------
// Subgraph computation
// ---------------------------------------------------------------------------

/** Read-only node types that never modify files. */
const READ_ONLY_NODE_TYPES: NodeType[] = [
  NodeType.RECON,
  NodeType.VALIDATION,
  NodeType.DIAGNOSIS,
  NodeType.ANALYSIS,
  NodeType.ELICIT_GATE,
];

/**
 * Find connected components among a set of node IDs using the given edges.
 * Returns an array of arrays, each containing the node IDs in one component.
 */
function connectedComponents(nodeIds: string[], edges: Edge[]): string[][] {
  const parent = new Map<string, string>();
  const nodeSet = new Set(nodeIds);

  for (const id of nodeIds) parent.set(id, id);

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    parent.set(find(a), find(b));
  }

  for (const edge of edges) {
    if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
      union(edge.from, edge.to);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }

  return [...groups.values()];
}

/**
 * Topologically sort a subset of nodes given only intra-subset edges.
 * Returns node IDs in dependency order.
 */
function topoSortSubset(nodeIds: string[], edges: Edge[]): string[] {
  const nodeSet = new Set(nodeIds);
  const relevant = edges.filter((e) =>
    nodeSet.has(e.from) && nodeSet.has(e.to)
  );

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of relevant) {
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted.push(cur);
    for (const nb of adj.get(cur) ?? []) {
      const nd = (inDegree.get(nb) ?? 0) - 1;
      inDegree.set(nb, nd);
      if (nd === 0) queue.push(nb);
    }
  }

  return sorted;
}

/**
 * Stable 8-character hash of a node-ID set.
 *
 * Used to derive subgraph IDs (`auto-<hash>`) so subgraph identity remains
 * constant when sibling subgraphs are added or removed. Order-insensitive —
 * the input set is sorted before hashing. djb2-style mix; not cryptographic.
 *
 * Output space is 32 bits (~4.3B). Birthday-collision probability rises near
 * ~65k components per session — well above any realistic graph. The
 * `applySubgraphs` post-condition throws on collision rather than silently
 * merging; widen the suffix length here if subgraph counts ever approach
 * that scale.
 */
export function hashNodeSet(nodeIds: string[]): string {
  const sorted = [...nodeIds].sort();
  let hash = 5381;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0;
    }
    hash = ((hash << 5) + hash + 0x7c) >>> 0; // 0x7c = '|' separator
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * Extract `exports:<path>` and `imports:<path>` from node tags.
 */
function extractTaggedPaths(
  graph: Graph,
  nodeIds: string[],
  prefix: string,
): string[] {
  const paths: string[] = [];
  for (const id of nodeIds) {
    const tags = graph.nodes[id]?.tags ?? [];
    for (const tag of tags) {
      if (tag.startsWith(`${prefix}:`)) {
        paths.push(tag.slice(prefix.length + 1));
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Compute subgraph partitions from the supergraph based on tier and strategy.
 *
 * - SELF: single subgraph containing all nodes, assigned to LEAD.
 * - INDEPENDENT: adjunct nodes partitioned by connected component; lead nodes
 *   form a single lead subgraph. VERIFY_COMPILE attaches to predecessor's subgraph.
 * - COORDINATED: same partitioning as INDEPENDENT with coordination contracts.
 */
export function computeSubgraphs(
  graph: Graph,
  _waves: Wave[],
  tier: Tier,
  strategy: SubgraphStrategy,
): Subgraph[] {
  const allNodeIds = Object.keys(graph.nodes);
  if (allNodeIds.length === 0) return [];

  if (strategy === SubgraphStrategy.SELF) {
    const sorted = topoSortSubset(allNodeIds, graph.edges);
    return [{
      id: "sg-lead",
      derived: true,
      nodes: sorted,
      edges: [...graph.edges],
      assignee: "LEAD",
      executor: Executor.LEAD,
      tier,
      coordination: { mode: CoordinationMode.NONE },
      completionPolicy: SubgraphCompletionPolicy.ALL,
      failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    }];
  }

  // Partition nodes by executor
  const adjunctNodeIds: string[] = [];
  const leadNodeIds: string[] = [];
  const verifyCompileIds: string[] = [];

  for (const id of allNodeIds) {
    const node = graph.nodes[id];
    if (node.type === NodeType.VERIFY_COMPILE) {
      verifyCompileIds.push(id);
    } else if (node.executor === Executor.ADJUNCT) {
      adjunctNodeIds.push(id);
    } else {
      leadNodeIds.push(id);
    }
  }

  // Build a map of DEPENDS_ON predecessors for VERIFY_COMPILE nodes
  const verifyPredecessor = new Map<string, string>();
  for (const vc of verifyCompileIds) {
    for (const edge of graph.edges) {
      if (edge.to === vc && edge.type === EdgeType.DEPENDS_ON) {
        verifyPredecessor.set(vc, edge.from);
        break;
      }
    }
  }

  // Find connected components among adjunct nodes
  const adjunctEdges = graph.edges.filter(
    (e) => adjunctNodeIds.includes(e.from) && adjunctNodeIds.includes(e.to),
  );
  const components = connectedComponents(adjunctNodeIds, adjunctEdges);

  // Build a lookup: nodeId -> component index
  const nodeToComponent = new Map<string, number>();
  for (let i = 0; i < components.length; i++) {
    for (const id of components[i]) {
      nodeToComponent.set(id, i);
    }
  }

  // Assign VERIFY_COMPILE nodes to their predecessor's component
  for (const vc of verifyCompileIds) {
    const pred = verifyPredecessor.get(vc);
    if (pred !== undefined && nodeToComponent.has(pred)) {
      const compIdx = nodeToComponent.get(pred)!;
      components[compIdx].push(vc);
      nodeToComponent.set(vc, compIdx);
    } else {
      // No adjunct predecessor — assign to lead
      leadNodeIds.push(vc);
    }
  }

  const subgraphs: Subgraph[] = [];

  // Lead subgraph
  if (leadNodeIds.length > 0) {
    const leadEdges = graph.edges.filter(
      (e) => leadNodeIds.includes(e.from) && leadNodeIds.includes(e.to),
    );
    const sorted = topoSortSubset(leadNodeIds, leadEdges);
    subgraphs.push({
      id: "sg-lead",
      derived: true,
      nodes: sorted,
      edges: leadEdges,
      assignee: "LEAD",
      executor: Executor.LEAD,
      tier,
      coordination: { mode: CoordinationMode.NONE },
      completionPolicy: SubgraphCompletionPolicy.ALL,
      failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    });
  }

  // Pre-compute stable IDs for every adjunct component so coordination contracts
  // can reference siblings by ID without depending on iteration order.
  const componentIds: string[] = components.map((compNodes) =>
    compNodes.length === 0 ? "" : `auto-${hashNodeSet(compNodes)}`
  );

  // Post-condition: no two non-empty components may produce the same hash ID.
  // A collision would silently merge distinct subgraphs — fail loudly instead.
  const nonEmptyIds = componentIds.filter((id) => id !== "");
  if (new Set(nonEmptyIds).size !== nonEmptyIds.length) {
    throw new Error(
      "Hash collision detected in computeSubgraphs: two adjunct components produced the same auto-<hash> ID. " +
        "This is probabilistically near-impossible with distinct node sets — inspect inputs for duplicated node IDs.",
    );
  }

  // Adjunct subgraphs (one per connected component)
  for (let i = 0; i < components.length; i++) {
    const compNodes = components[i];
    if (compNodes.length === 0) continue;

    const compSet = new Set(compNodes);
    const compEdges = graph.edges.filter(
      (e) => compSet.has(e.from) && compSet.has(e.to),
    );
    const sorted = topoSortSubset(compNodes, compEdges);

    const sgId = componentIds[i];

    // Determine coordination mode
    let coordination: CoordinationContract;
    if (strategy === SubgraphStrategy.COORDINATED) {
      const isReadOnly = compNodes.every((id) => {
        const node = graph.nodes[id];
        return READ_ONLY_NODE_TYPES.includes(node.type) ||
          node.type === NodeType.VERIFY_COMPILE;
      });

      // Find inter-subgraph dependencies
      const dependsOn: string[] = [];
      for (const edge of graph.edges) {
        if (compSet.has(edge.to) && !compSet.has(edge.from)) {
          // Find which subgraph the source belongs to
          const srcComp = nodeToComponent.get(edge.from);
          if (srcComp !== undefined) {
            const depSgId = componentIds[srcComp];
            if (depSgId && !dependsOn.includes(depSgId)) {
              dependsOn.push(depSgId);
            }
          } else if (
            leadNodeIds.includes(edge.from) && !dependsOn.includes("sg-lead")
          ) {
            dependsOn.push("sg-lead");
          }
        }
      }

      coordination = {
        mode: isReadOnly
          ? CoordinationMode.ADVERSARIAL
          : CoordinationMode.PARTITIONED,
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        exports: extractTaggedPaths(graph, compNodes, "exports"),
        imports: extractTaggedPaths(graph, compNodes, "imports"),
      };
      // Clean empty arrays
      if (coordination.exports!.length === 0) delete coordination.exports;
      if (coordination.imports!.length === 0) delete coordination.imports;
    } else {
      coordination = { mode: CoordinationMode.PARTITIONED };
    }

    subgraphs.push({
      id: sgId,
      derived: true,
      nodes: sorted,
      edges: compEdges,
      assignee: "", // Populated by caller after designation generation
      executor: Executor.ADJUNCT,
      tier,
      coordination,
      completionPolicy: SubgraphCompletionPolicy.ALL,
      failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    });
  }

  return subgraphs;
}

// ---------------------------------------------------------------------------
// Explicit subgraph creation
// ---------------------------------------------------------------------------

/**
 * Specification for adding an explicit (non-derived) subgraph.
 */
export interface AddSubgraphSpec {
  /** Stable subgraph slug. Must match `^[a-z](?:[a-z0-9-]{0,39}[a-z0-9])?$` (length 1–41,
   * trailing character must be alphanumeric), not equal `sg-lead`, not start with `auto-`. */
  slug: string;
  /** Optional human-readable label. */
  label?: string;
  /** Optional parent subgraph ID for hierarchical nesting. */
  parentId?: string;
  /** Who executes nodes in this subgraph. */
  executor: Executor;
  /** Member node IDs. Must exist in the graph; must not overlap any other explicit subgraph. */
  nodeIds: string[];
  /** Execution tier. */
  tier: Tier;
  /** Optional coordination contract. Defaults to `{ mode: NONE }`. */
  coordination?: CoordinationContract;
  /** Optional completion policy. Defaults to `ALL`. */
  completionPolicy?: SubgraphCompletionPolicy;
  /** Optional failure policy. Defaults to `FAIL_FAST`. */
  failurePolicy?: SubgraphFailurePolicy;
  /** Optional gate references. Node-ID gates must be members of `nodeIds`.
   * External gates (object form) require non-empty `source` and `externalId`. */
  gates?: SubgraphGate[];
}

export const SUBGRAPH_SLUG_RE = /^[a-z](?:[a-z0-9-]{0,39}[a-z0-9])?$/;

/**
 * Validate a spec and produce a new explicit Subgraph value, leaving the graph
 * itself untouched. Caller is responsible for appending the result to the
 * checkpoint's subgraphs and stamping `node.subgraph` onto member nodes.
 *
 * Validation:
 * - slug matches `^[a-z](?:[a-z0-9-]{0,39}[a-z0-9])?$` (length 1–41, trailing char alphanumeric),
 *   isn't `sg-lead`, doesn't start with `auto-`
 * - slug is unique among existing subgraph IDs (idempotent re-add: same spec returns existing;
 *   differing spec returns error)
 * - all `nodeIds` exist in the graph and are unique
 * - `parentId` (if set) refers to an existing subgraph
 * - no `nodeId` already belongs to another explicit subgraph
 * - node-ID gates are members of `nodeIds`; external gates have non-empty `source` and `externalId`
 * - `BEST_EFFORT` failure policy requires at least one gate (otherwise degenerates to CONTINUE)
 */
/**
 * Compare two SubgraphGate arrays for semantic equality.
 * Order-insensitive for both node-ID gates and external gates.
 */
function gatesEqual(
  a: SubgraphGate[] | undefined,
  b: SubgraphGate[] | undefined,
): boolean {
  const aArr = a ?? [];
  const bArr = b ?? [];
  if (aArr.length !== bArr.length) return false;

  const stringify = (g: SubgraphGate): string => {
    if (typeof g === "string") return `node:${g}`;
    return `external:${g.source}:${g.externalId}`;
  };

  const aSet = new Set(aArr.map(stringify));
  const bSet = new Set(bArr.map(stringify));
  if (aSet.size !== bSet.size) return false;
  for (const s of aSet) {
    if (!bSet.has(s)) return false;
  }
  return true;
}

/**
 * Check whether an existing subgraph's spec matches the incoming spec field-by-field.
 * Used to implement idempotent re-add semantics.
 */
function subgraphsEquivalent(
  existing: Subgraph,
  spec: AddSubgraphSpec,
): boolean {
  // Slug already matched by the caller. Check the remaining fields.
  const existingNodeSet = new Set(existing.nodes);
  const specNodeSet = new Set(spec.nodeIds);
  if (existingNodeSet.size !== specNodeSet.size) return false;
  for (const id of existingNodeSet) {
    if (!specNodeSet.has(id)) return false;
  }

  if (existing.executor !== spec.executor) return false;
  if (existing.tier !== spec.tier) return false;

  const effectiveCompletion = spec.completionPolicy ??
    SubgraphCompletionPolicy.ALL;
  const effectiveFailure = spec.failurePolicy ??
    SubgraphFailurePolicy.FAIL_FAST;
  if (existing.completionPolicy !== effectiveCompletion) return false;
  if (existing.failurePolicy !== effectiveFailure) return false;

  // parentId
  const specParent = spec.parentId ?? undefined;
  if (existing.parentId !== specParent) return false;

  if (!gatesEqual(existing.gates, spec.gates)) return false;

  return true;
}

export function addSubgraph(
  graph: Graph,
  currentSubgraphs: Subgraph[],
  spec: AddSubgraphSpec,
): MutationResult<Subgraph> {
  if (!SUBGRAPH_SLUG_RE.test(spec.slug)) {
    return {
      ok: false,
      error:
        `Invalid slug "${spec.slug}" — must match ${SUBGRAPH_SLUG_RE.source}`,
    };
  }
  if (spec.slug === "sg-lead") {
    return {
      ok: false,
      error: `Slug "sg-lead" is reserved for the auto-derived lead subgraph`,
    };
  }
  if (spec.slug.startsWith("auto-")) {
    return {
      ok: false,
      error:
        `Slug "${spec.slug}" is reserved — the "auto-" prefix is used for auto-derived subgraph IDs`,
    };
  }

  // Idempotency: if slug already exists, compare specs.
  const existing = currentSubgraphs.find((sg) => sg.id === spec.slug);
  if (existing) {
    if (subgraphsEquivalent(existing, spec)) {
      return { ok: true, value: existing };
    }
    return {
      ok: false,
      error:
        `Subgraph "${spec.slug}" already exists with a different spec — re-add rejected`,
    };
  }

  if (spec.nodeIds.length === 0) {
    return { ok: false, error: "Subgraph must contain at least one node" };
  }
  if (new Set(spec.nodeIds).size !== spec.nodeIds.length) {
    return { ok: false, error: "Duplicate node IDs in spec" };
  }
  for (const nodeId of spec.nodeIds) {
    if (!(nodeId in graph.nodes)) {
      return { ok: false, error: `Node "${nodeId}" does not exist in graph` };
    }
  }
  if (
    spec.parentId && !currentSubgraphs.some((sg) => sg.id === spec.parentId)
  ) {
    return {
      ok: false,
      error: `Parent subgraph "${spec.parentId}" does not exist`,
    };
  }

  // No overlap with other explicit subgraphs. Derived subgraphs are allowed to
  // overlap; they are recomputed against the unclaimed-node set on next
  // compute_subgraphs run.
  const explicitMembership = new Map<string, string>();
  for (const sg of currentSubgraphs) {
    if (sg.derived) continue;
    for (const id of sg.nodes) explicitMembership.set(id, sg.id);
  }
  for (const nodeId of spec.nodeIds) {
    if (explicitMembership.has(nodeId)) {
      return {
        ok: false,
        error: `Node "${nodeId}" already belongs to explicit subgraph "${
          explicitMembership.get(nodeId)
        }"`,
      };
    }
  }

  // M2: BEST_EFFORT requires at least one gate; without gates it degenerates to CONTINUE.
  const failurePolicy = spec.failurePolicy ?? SubgraphFailurePolicy.FAIL_FAST;
  if (failurePolicy === SubgraphFailurePolicy.BEST_EFFORT) {
    if (!spec.gates || spec.gates.length === 0) {
      return {
        ok: false,
        error:
          "BEST_EFFORT failure policy requires at least one gate — without gates it degenerates to CONTINUE",
      };
    }
  }

  if (spec.gates) {
    const memberSet = new Set(spec.nodeIds);
    for (const gate of spec.gates) {
      if (typeof gate === "string") {
        // Node-ID gate: must be a member of nodeIds.
        if (!memberSet.has(gate)) {
          return {
            ok: false,
            error: `Gate node "${gate}" is not a member of this subgraph`,
          };
        }
      } else {
        // External gate: source and externalId must be non-empty.
        if (!gate.source || gate.source.trim() === "") {
          return {
            ok: false,
            error: `External gate is missing a non-empty "source" field`,
          };
        }
        if (!gate.externalId || gate.externalId.trim() === "") {
          return {
            ok: false,
            error: `External gate is missing a non-empty "externalId" field`,
          };
        }
      }
    }
  }

  const sortedNodes = topoSortSubset(spec.nodeIds, graph.edges);
  const memberSet = new Set(spec.nodeIds);
  const internalEdges = graph.edges.filter(
    (e) => memberSet.has(e.from) && memberSet.has(e.to),
  );

  const subgraph: Subgraph = {
    id: spec.slug,
    derived: false,
    nodes: sortedNodes,
    edges: internalEdges,
    assignee: spec.executor === Executor.LEAD ? "LEAD" : "",
    executor: spec.executor,
    tier: spec.tier,
    coordination: spec.coordination ?? { mode: CoordinationMode.NONE },
    completionPolicy: spec.completionPolicy ?? SubgraphCompletionPolicy.ALL,
    failurePolicy,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
    ...(spec.gates ? { gates: spec.gates } : {}),
  };

  return { ok: true, value: subgraph };
}

// ---------------------------------------------------------------------------
// Subgraph completion / failure evaluation
// ---------------------------------------------------------------------------

/** Outcome of evaluating a subgraph's nodes against its policies. */
export type SubgraphOutcome = "pending" | "active" | "completed" | "failed";

const TERMINAL_OK: NodeStatus[] = [
  NodeStatus.DONE,
  NodeStatus.MERGED,
  NodeStatus.PR_CREATED,
];

/**
 * Evaluate a subgraph's overall status against its `completionPolicy` and
 * `failurePolicy`, given the current node states.
 *
 * **Evaluation order**: failure policy is checked **before** completion policy.
 * This means a tripped failure policy always wins, even when the completion
 * policy could also be satisfied simultaneously.
 *
 * **ANY + FAIL_FAST ordering example** (intentional, locked by contract):
 * Given nodes `[DONE, FAILED]`, `completionPolicy=ANY`, `failurePolicy=FAIL_FAST`:
 * - FAIL_FAST trips first (a FAILED node exists) → outcome is `"failed"`.
 * - The ANY completion check never runs.
 * This is intentional: failure short-circuits. Use `CONTINUE` or `BEST_EFFORT`
 * if you want failures to be tolerated alongside ANY completion.
 *
 * **GATED + external gates**: gates may be node IDs or external gate objects
 * (see `SubgraphGate`). This function is the **synchronous variant** — it
 * conservatively treats every external gate as unresolved, making it safe for
 * in-loop callers that have no async boundary. A subgraph with any external
 * gates will therefore never reach `"completed"` via GATED in this variant, and
 * BEST_EFFORT will always trip on an external gate as failed.
 *
 * For the snapshot-aware async-boundary variant that resolves external gates
 * against pre-fetched blocker counts, see `subgraphOutcomeWithBlockers`.
 *
 * Failure policy is checked first; if it has tripped, the subgraph is failed.
 * Otherwise, completion policy is evaluated against "settled" nodes — a node
 * is settled when it is OK (DONE/MERGED/PR_CREATED) **or** failed in a way
 * the failure policy tolerates (CONTINUE tolerates any FAILED; BEST_EFFORT
 * tolerates FAILED non-gate nodes).
 *
 * Returns:
 * - `failed` — failure policy threshold tripped
 * - `completed` — completion policy is satisfied
 * - `active` — at least one node is ACTIVE
 * - `pending` — none of the above
 */
export function subgraphOutcome(
  graph: Graph,
  subgraph: Subgraph,
): SubgraphOutcome {
  type Member = { id: string; status: NodeStatus };
  const members: Member[] = subgraph.nodes
    .map((id) => ({ id, status: graph.nodes[id]?.status }))
    .filter((m): m is Member => m.status !== undefined);
  if (members.length === 0) return "pending";

  // Partition gates into node-ID gates (resolvable here) and external gates.
  const rawGates = subgraph.gates ?? [];
  const nodeGateIds = new Set<string>(
    rawGates.filter((g): g is string => typeof g === "string"),
  );
  const externalGates = rawGates.filter((g) => typeof g !== "string");
  // External gates without a cached blocker snapshot are treated as unresolved.
  // Resolution requires the async getExternalBlockers call at the dispatch boundary
  // in server.ts; see subgraphOutcomeWithBlockers for the snapshot-aware variant.
  const hasUnresolvedExternalGates = externalGates.length > 0;

  const nodeGates: Member[] = members.filter((m) => nodeGateIds.has(m.id));

  const isOk = (s: NodeStatus): boolean => TERMINAL_OK.includes(s);
  const isFailed = (s: NodeStatus): boolean => s === NodeStatus.FAILED;

  // Failure policy first — a tripped subgraph is terminal regardless of remaining work.
  switch (subgraph.failurePolicy) {
    case SubgraphFailurePolicy.FAIL_FAST:
      if (members.some((m) => isFailed(m.status))) return "failed";
      break;
    case SubgraphFailurePolicy.CONTINUE:
      if (members.every((m) => isFailed(m.status))) return "failed";
      break;
    case SubgraphFailurePolicy.BEST_EFFORT:
      // External gates are always unresolved — treat as failed for BEST_EFFORT.
      if (hasUnresolvedExternalGates) return "failed";
      if (nodeGates.some((g) => isFailed(g.status))) return "failed";
      break;
  }

  // A node is "settled" when it is terminal-OK or its failure is tolerated by policy.
  const settled = (m: Member): boolean => {
    if (isOk(m.status)) return true;
    if (!isFailed(m.status)) return false;
    if (subgraph.failurePolicy === SubgraphFailurePolicy.CONTINUE) return true;
    if (
      subgraph.failurePolicy === SubgraphFailurePolicy.BEST_EFFORT &&
      !nodeGateIds.has(m.id)
    ) return true;
    return false;
  };

  switch (subgraph.completionPolicy) {
    case SubgraphCompletionPolicy.ALL:
      if (members.every(settled)) return "completed";
      break;
    case SubgraphCompletionPolicy.ANY:
      if (members.some((m) => isOk(m.status))) return "completed";
      break;
    case SubgraphCompletionPolicy.GATED: {
      // External gates are always unresolved — GATED never completes if any are present.
      if (hasUnresolvedExternalGates) break;
      if (nodeGates.length > 0 && nodeGates.every((g) => isOk(g.status))) {
        return "completed";
      }
      break;
    }
  }

  if (members.some((m) => m.status === NodeStatus.ACTIVE)) return "active";
  return "pending";
}

/**
 * Snapshot-aware variant of `subgraphOutcome` that incorporates pre-fetched
 * external-blocker counts.
 *
 * **Design rationale**: `subgraphOutcome` is intentionally synchronous so it
 * can be called freely during graph traversal without async overhead. Making it
 * async would be a breaking change to every call site. The async
 * `getExternalBlockers` call happens once at the dispatch boundary in server.ts;
 * the resolved counts are placed in `blockerSnapshot` keyed by brain task ID.
 *
 * External gates that carry a `taskId` look up their unresolved count from the
 * snapshot: count === 0 means the gate is resolved. Gates without a `taskId`
 * fall back to the conservative "always unresolved" behavior.
 *
 * @param graph - The full execution graph.
 * @param subgraph - The subgraph to evaluate.
 * @param blockerSnapshot - Map of `taskId → unresolved external blocker count`
 *   collected at the dispatch boundary. Pass an empty Map to reproduce the
 *   behavior of `subgraphOutcome` (all external gates treated as unresolved).
 */
export function subgraphOutcomeWithBlockers(
  graph: Graph,
  subgraph: Subgraph,
  blockerSnapshot: Map<string, number>,
): SubgraphOutcome {
  type Member = { id: string; status: NodeStatus };
  const members: Member[] = subgraph.nodes
    .map((id) => ({ id, status: graph.nodes[id]?.status }))
    .filter((m): m is Member => m.status !== undefined);
  if (members.length === 0) return "pending";

  const rawGates = subgraph.gates ?? [];
  const nodeGateIds = new Set<string>(
    rawGates.filter((g): g is string => typeof g === "string"),
  );
  const externalGates = rawGates.filter((g) => typeof g !== "string");

  // Resolve each external gate using the snapshot. A gate is unresolved when:
  // - it has no taskId (no lookup possible), OR
  // - its taskId is absent from the snapshot (never queried), OR
  // - the snapshot reports unresolvedCount > 0.
  const hasUnresolvedExternalGates = externalGates.some((g) => {
    if (typeof g === "string") return false;
    const tId = (g as { taskId?: string }).taskId;
    if (!tId) return true; // no taskId → conservative: treat as unresolved
    const count = blockerSnapshot.get(tId);
    return count === undefined || count > 0;
  });

  const nodeGates: Member[] = members.filter((m) => nodeGateIds.has(m.id));

  const isOk = (s: NodeStatus): boolean => TERMINAL_OK.includes(s);
  const isFailed = (s: NodeStatus): boolean => s === NodeStatus.FAILED;

  switch (subgraph.failurePolicy) {
    case SubgraphFailurePolicy.FAIL_FAST:
      if (members.some((m) => isFailed(m.status))) return "failed";
      break;
    case SubgraphFailurePolicy.CONTINUE:
      if (members.every((m) => isFailed(m.status))) return "failed";
      break;
    case SubgraphFailurePolicy.BEST_EFFORT:
      if (hasUnresolvedExternalGates) return "failed";
      if (nodeGates.some((g) => isFailed(g.status))) return "failed";
      break;
  }

  const settled = (m: Member): boolean => {
    if (isOk(m.status)) return true;
    if (!isFailed(m.status)) return false;
    if (subgraph.failurePolicy === SubgraphFailurePolicy.CONTINUE) return true;
    if (
      subgraph.failurePolicy === SubgraphFailurePolicy.BEST_EFFORT &&
      !nodeGateIds.has(m.id)
    ) return true;
    return false;
  };

  switch (subgraph.completionPolicy) {
    case SubgraphCompletionPolicy.ALL:
      if (members.every(settled)) return "completed";
      break;
    case SubgraphCompletionPolicy.ANY:
      if (members.some((m) => isOk(m.status))) return "completed";
      break;
    case SubgraphCompletionPolicy.GATED: {
      if (hasUnresolvedExternalGates) break;
      if (nodeGates.length > 0 && nodeGates.every((g) => isOk(g.status))) {
        return "completed";
      }
      break;
    }
  }

  if (members.some((m) => m.status === NodeStatus.ACTIVE)) return "active";
  return "pending";
}

// ---------------------------------------------------------------------------
// Subgraph brief serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a subgraph into a markdown dispatch brief for an adjunct.
 * The brief is the strict execution contract — the adjunct traverses nodes in order.
 */
export function serializeSubgraphBrief(
  graph: Graph,
  subgraph: Subgraph,
): string {
  const lines: string[] = [];

  const heading = subgraph.label
    ? `## Subgraph: ${subgraph.id} — ${subgraph.label}`
    : `## Subgraph: ${subgraph.id}`;
  lines.push(heading);
  if (subgraph.parentId) lines.push(`Parent: ${subgraph.parentId}`);
  lines.push(`Assignee: ${subgraph.assignee}`);
  lines.push(`Executor: ${subgraph.executor}`);
  lines.push(`Coordination: ${subgraph.coordination.mode}`);
  if (
    subgraph.completionPolicy !== SubgraphCompletionPolicy.ALL ||
    subgraph.failurePolicy !== SubgraphFailurePolicy.FAIL_FAST
  ) {
    lines.push(
      `Policies: completion=${subgraph.completionPolicy}, failure=${subgraph.failurePolicy}`,
    );
  }
  if (subgraph.gates?.length) {
    const gateStrs = subgraph.gates.map((g) =>
      typeof g === "string" ? g : `external:${g.source}:${g.externalId}`
    );
    lines.push(`Gates: ${gateStrs.join(", ")}`);
  }
  lines.push("");

  lines.push("### Traversal Order");
  for (let i = 0; i < subgraph.nodes.length; i++) {
    const nodeId = subgraph.nodes[i];
    const node = graph.nodes[nodeId];
    if (node) {
      lines.push(`${i + 1}. [${node.type}] ${node.label} (node: ${nodeId})`);
    }
  }
  lines.push("");

  const coord = subgraph.coordination;
  if (
    coord.mode !== CoordinationMode.NONE &&
    (coord.dependsOn?.length || coord.exports?.length || coord.imports?.length)
  ) {
    lines.push("### Coordination Contract");
    if (coord.exports?.length) {
      lines.push(`- Exports: ${coord.exports.join(", ")}`);
    }
    if (coord.imports?.length) {
      lines.push(`- Imports: ${coord.imports.join(", ")}`);
    }
    if (coord.dependsOn?.length) {
      lines.push(`- Depends on: ${coord.dependsOn.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Wave parallelism analysis
// ---------------------------------------------------------------------------

/**
 * Group nodes within a wave into parallel execution batches.
 *
 * Nodes connected by STACKED edges within the wave must execute sequentially.
 * Independent nodes form parallel groups. Returns an array of batches — each
 * batch contains node IDs that can execute simultaneously.
 */
export function parallelNodesInWave(
  graph: Graph,
  wave: Wave,
): string[][] {
  if (wave.nodes.length === 0) return [];

  const waveSet = new Set(wave.nodes);

  // Find STACKED chains within this wave
  const stackedEdges = graph.edges.filter(
    (e) =>
      e.type === EdgeType.STACKED &&
      waveSet.has(e.from) &&
      waveSet.has(e.to),
  );

  if (stackedEdges.length === 0) {
    // All nodes are independent — single parallel batch
    return [wave.nodes];
  }

  // Build adjacency for stacked chains
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of wave.nodes) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of stackedEdges) {
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // Find connected components to identify independent chains
  const components = connectedComponents(wave.nodes, stackedEdges);

  // For each component, topologically sort to get sequential order
  // Components of size 1 are fully independent
  const batches: string[][] = [];
  const independentNodes: string[] = [];

  for (const comp of components) {
    if (comp.length === 1) {
      independentNodes.push(comp[0]);
    } else {
      // This is a stacked chain — must be sequential
      const sorted = topoSortSubset(comp, stackedEdges);
      batches.push(sorted);
    }
  }

  // All independent nodes form one parallel batch
  if (independentNodes.length > 0) {
    batches.unshift(independentNodes);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Continuous frontier scheduling (UNM-1b7.5)
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from node ID → wave number.
 *
 * Nodes absent from every wave are not included in the map.
 */
export function nodeToWave(graph: Graph, waves: Wave[]): Map<string, number> {
  void graph; // graph param is reserved for future node-existence validation
  const result = new Map<string, number>();
  for (const wave of waves) {
    for (const nodeId of wave.nodes) {
      result.set(nodeId, wave.id);
    }
  }
  return result;
}

/**
 * Return the continuous frontier: every node that is simultaneously
 * `NodeStatus.PENDING` and `ReadinessStatus.READY`, regardless of which wave
 * it belongs to.
 *
 * This unlocks cross-wave parallelism: when a later-wave node's dependencies
 * clear before earlier-wave nodes finish, it appears on the frontier and can
 * be dispatched immediately — no wave-serialization barrier.
 *
 * Entries are sorted by (wave asc, nodeId asc) for deterministic output.
 * The wave number is carried purely as a dispatch hint; consumers may group,
 * filter, or ignore it.
 *
 * Nodes whose `readinessStatus` is undefined are treated as `READY` (backwards
 * compatibility with pre-2.5.0 checkpoints that lack the field).
 *
 * **Advisory contract**: `currentFrontier` is read-time advisory. It does
 * NOT consult lease fences (a parallel caller may have already dispatched
 * the node), capability requirements (those are checked by `dispatch_wave`
 * with caller `Capabilities`), or fresh external-blocker state (the cached
 * `externallyBlocked` axis is honored, but the brain may have updated since).
 * Authoritative activation lives in `dispatch_wave`, which mints fences,
 * re-consults brain, and rejects on capability mismatch. Two callers reading
 * the same frontier may both see the same node; only one's WorkPacket
 * survives the next mint. Use the frontier for batching and UI; use
 * `dispatch_wave` for actual activation.
 */
export function currentFrontier(graph: Graph, waves: Wave[]): FrontierEntry[] {
  const waveOf = nodeToWave(graph, waves);
  const entries: FrontierEntry[] = [];

  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.status !== NodeStatus.PENDING) continue;
    // Treat undefined readinessStatus as READY (pre-2.5.0 compat)
    const ready = node.readinessStatus === undefined ||
      node.readinessStatus === ReadinessStatus.READY;
    if (!ready) continue;
    // Filter on the orthogonal external-blocker axis. A node with unresolved
    // external blockers is topologically READY (edges satisfied) but not
    // frontier-eligible — `dispatch_wave` would refuse activation. Treating
    // both axes as required avoids the frontier lying about dispatchability.
    if (node.externallyBlocked === true) continue;
    const wave = waveOf.get(nodeId) ?? 0;
    entries.push({ nodeId, wave });
  }

  // Sort by (wave asc, nodeId asc) for determinism
  entries.sort((a, b) =>
    a.wave !== b.wave ? a.wave - b.wave : a.nodeId.localeCompare(b.nodeId)
  );

  return entries;
}

/**
 * Return one dispatch batch per wave that has at least one frontier-eligible
 * node, across all waves simultaneously (continuous-frontier alternative to
 * `nextWave`).
 *
 * Each batch contains the wave number and the IDs of PENDING+READY nodes in
 * that wave. Batches are ordered by wave number (ascending). Empty waves are
 * omitted.
 *
 * The `currentWaveId` parameter is retained for API symmetry with `nextWave`
 * and caller context; this function does NOT filter by it — the continuous
 * frontier is wave-order-independent.
 */
export function nextFrontierBatch(
  graph: Graph,
  waves: Wave[],
  _currentWaveId: number | null,
): { wave: number; nodeIds: string[] }[] {
  const frontier = currentFrontier(graph, waves);
  if (frontier.length === 0) return [];

  // Group entries by wave, preserving sort order from currentFrontier
  const byWave = new Map<number, string[]>();
  for (const entry of frontier) {
    if (!byWave.has(entry.wave)) byWave.set(entry.wave, []);
    byWave.get(entry.wave)!.push(entry.nodeId);
  }

  // Return as array of {wave, nodeIds}, wave-ascending (already ordered by insertion)
  return [...byWave.entries()].map(([wave, nodeIds]) => ({ wave, nodeIds }));
}
