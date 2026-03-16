/**
 * Pure DAG computation engine for the trimatrix cross-repository orchestration system.
 *
 * Provides topological sort, wave computation, gate management, cycle detection,
 * and node state mutation — all as pure functions returning new graph copies.
 */

import type { Edge, Graph, Node, Wave } from "./types.ts";
import { EdgeType, NodeStatus } from "./types.ts";

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
      const bump = (eType === EdgeType.MERGE_GATE || eType === EdgeType.DEPENDS_ON) ? 1 : 0;
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
    if (edge.type === EdgeType.MERGE_GATE || edge.type === EdgeType.DEPENDS_ON) {
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

  // Build a map of incoming edges per node
  const incomingEdges = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    if (!incomingEdges.has(edge.to)) incomingEdges.set(edge.to, []);
    incomingEdges.get(edge.to)!.push(edge);
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
      const edges = incomingEdges.get(nId) ?? [];
      return edges.every((edge) => {
        if (waveNodeIds.has(edge.from)) return true; // intra-wave: always ok
        const sourceNode = graph.nodes[edge.from];
        if (!sourceNode) return false;
        if (edge.type === EdgeType.MERGE_GATE) {
          return sourceNode.status === MERGE_GATE_SATISFIED;
        }
        if (edge.type === EdgeType.DEPENDS_ON) {
          return DEPENDS_ON_SATISFIED.includes(sourceNode.status);
        }
        // STACKED
        return STACKED_SATISFIED.includes(sourceNode.status);
      });
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
      [nodeId]: { ...node, status: NodeStatus.ACTIVE, failureReason: undefined },
    },
  };
}

/**
 * Mark a node as completed.
 * - With PR info: status becomes PR_CREATED.
 * - Without PR info and node has repo: status becomes MERGED.
 * - Without PR info and no repo (single-repo): status becomes DONE.
 */
export function completeNode(
  graph: Graph,
  nodeId: string,
  pr?: { url: string; number: number },
): Graph {
  const node = graph.nodes[nodeId];
  if (!node) return graph;
  const updated: Node = {
    ...node,
    status: pr ? NodeStatus.PR_CREATED : (node.repo ? NodeStatus.MERGED : NodeStatus.DONE),
    ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}),
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

  return {
    ok: true,
    value: {
      ...graph,
      nodes: { ...graph.nodes, [node.id]: node },
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
      const bump = (eType === EdgeType.MERGE_GATE || eType === EdgeType.DEPENDS_ON) ? 1 : 0;
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
    if (edge.type === EdgeType.MERGE_GATE || edge.type === EdgeType.DEPENDS_ON) {
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

  const statuses = wave.nodes.map((id) => graph.nodes[id]?.status ?? NodeStatus.PENDING);

  const allTerminal = statuses.every((s) => s === NodeStatus.MERGED || s === NodeStatus.DONE);
  if (allTerminal) return "completed";

  const failedOrBlocked = (s: NodeStatus | undefined) =>
    s === NodeStatus.FAILED || s === NodeStatus.BLOCKED;
  const allFailed = statuses.every(failedOrBlocked);
  if (allFailed) return "failed";

  const hasFailure = statuses.some(failedOrBlocked);
  const hasCompleted = statuses.some(
    (s) => s === NodeStatus.MERGED || s === NodeStatus.PR_CREATED || s === NodeStatus.DONE,
  );
  if (hasFailure && hasCompleted) return "partial_failure";
  if (hasFailure) return "failed";

  const hasActive = statuses.some((s) => s === NodeStatus.ACTIVE);
  if (hasActive) return "active";

  return "pending";
}
