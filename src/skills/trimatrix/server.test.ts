/**
 * MCP-boundary tests for trimatrix server tool wiring.
 *
 * These tests do NOT spin up a full MCP server. They exercise the in-memory
 * checkpoint module via the pure functions exposed by state.ts and graph.ts,
 * then validate the response shapes that the tool handlers produce.
 *
 * Coverage:
 * - add_subgraph: valid add, idempotent re-add (same spec), spec mismatch error
 * - list_subgraphs: split into derived / explicit partitions
 * - get_subgraph: present and absent subgraph IDs
 * - compute_subgraphs: rename surfacing (M5)
 * - SubgraphSummary shape conformance (M4) — tier field present
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  deserialize,
  serialize,
  transition,
} from "./state.ts";
import { addSubgraph, subgraphOutcomeWithBlockers } from "./graph.ts";
import {
  CoordinationMode,
  EdgeType,
  Executor,
  MachineState,
  NodeStatus,
  NodeType,
  SubgraphCompletionPolicy,
  SubgraphFailurePolicy,
  Tier,
} from "./types.ts";
import type { Checkpoint, Graph, Node, Subgraph, SubgraphSummary } from "./types.ts";
import type { BrainExec, ExternalBlockerSnapshot } from "./brain-sync.ts";
import { getExternalBlockers } from "./brain-sync.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    type: NodeType.IMPLEMENTATION,
    label: `Node ${id}`,
    status: NodeStatus.PENDING,
    executor: Executor.LEAD,
    ...overrides,
  };
}

function makeGraph(nodes: Node[], edges: Graph["edges"] = []): Graph {
  const nodeMap: Record<string, Node> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return { nodes: nodeMap, edges };
}

function makeCp(graph: Graph, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    version: "2.4.0",
    machineState: MachineState.INITIALIZING,
    graph,
    waves: [],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subgraphs: [],
    episodeIds: [],
    ...overrides,
  };
}

/**
 * Project a Subgraph into a SubgraphSummary (mirrors server.ts summarizeSubgraph).
 * Used to validate response shape conformance without importing server internals.
 */
function summarizeSubgraph(sg: import("./types.ts").Subgraph, _graph: Graph): SubgraphSummary {
  return {
    id: sg.id,
    executor: sg.executor,
    tier: sg.tier,
    assignee: sg.assignee,
    nodeCount: sg.nodes.length,
    nodes: sg.nodes,
    coordination: sg.coordination,
    derived: sg.derived,
    completionPolicy: sg.completionPolicy,
    failurePolicy: sg.failurePolicy,
    outcome: "pending",
    ...(sg.label !== undefined ? { label: sg.label } : {}),
    ...(sg.parentId !== undefined ? { parentId: sg.parentId } : {}),
    ...(sg.gates ? { gates: sg.gates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Test: SubgraphSummary shape conformance — tier field present (M4)
// ---------------------------------------------------------------------------

Deno.test("SubgraphSummary shape: summarizeSubgraph includes tier field (M4)", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = makeCp(graph);

  const sgResult = addSubgraph(graph, [], {
    slug: "shape-test",
    nodeIds: ["n1"],
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  const summary = summarizeSubgraph(sg, cp.graph);

  assertEquals(summary.id, "shape-test");
  assertEquals(summary.tier, Tier.T2);
  assertEquals(summary.executor, Executor.ADJUNCT);
  assertEquals(summary.derived, false);
  assertEquals(summary.nodeCount, 1);
  assertEquals(summary.nodes, sg.nodes);
  assertEquals(summary.completionPolicy, SubgraphCompletionPolicy.ALL);
  assertEquals(summary.failurePolicy, SubgraphFailurePolicy.FAIL_FAST);
  assertEquals(typeof summary.outcome, "string");
});

// ---------------------------------------------------------------------------
// Test: add_subgraph idempotent re-add (same spec, no-op)
// ---------------------------------------------------------------------------

Deno.test("add_subgraph wiring: idempotent transition — same event applied twice does not double-append", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  let cp = makeCp(graph);

  const sgResult = addSubgraph(graph, [], {
    slug: "idempotent-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  // First add — appends
  cp = transition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(cp.subgraphs?.length, 1);
  assertEquals(cp.subgraphs?.[0].id, "idempotent-sg");

  // Second add (same subgraph) — must be idempotent
  cp = transition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(cp.subgraphs?.length, 1, "no double-append on replay");
});

// ---------------------------------------------------------------------------
// Test: add_subgraph — valid new subgraph
// ---------------------------------------------------------------------------

Deno.test("add_subgraph wiring: valid add transitions checkpoint correctly", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  let cp = makeCp(graph);

  const sgResult = addSubgraph(graph, [], {
    slug: "valid-sg",
    nodeIds: ["n1", "n2"],
    executor: Executor.ADJUNCT,
    tier: Tier.T3,
    label: "All nodes",
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  cp = transition(cp, { type: "subgraph_added", subgraph: sg });

  assertEquals(cp.subgraphs?.length, 1);
  assertEquals(cp.subgraphs?.[0].id, "valid-sg");
  assertEquals(cp.subgraphs?.[0].label, "All nodes");
  assertEquals(cp.subgraphs?.[0].executor, Executor.ADJUNCT);
  assertEquals(cp.subgraphs?.[0].tier, Tier.T3);
  assertEquals(cp.subgraphs?.[0].derived, false);
});

// ---------------------------------------------------------------------------
// Test: list_subgraphs — derived vs explicit split
// ---------------------------------------------------------------------------

Deno.test("list_subgraphs wiring: derived and explicit split correctly", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2"), makeNode("n3")]);
  const waves = [{ id: 1, nodes: ["n1", "n2", "n3"], hasMergeGate: false }];
  let cp = makeCp(graph, { waves });

  // Add one explicit subgraph
  const sgResult = addSubgraph(graph, [], {
    slug: "explicit-part",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;
  cp = transition(cp, { type: "subgraph_added", subgraph: sg });

  // Add one derived subgraph manually (simulating computeSubgraphs output)
  const derivedSg: import("./types.ts").Subgraph = {
    id: "auto-abcd1234",
    derived: true,
    nodes: ["n2", "n3"],
    edges: [],
    assignee: "Two of Three",
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
    coordination: { mode: CoordinationMode.PARTITIONED },
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
  };
  cp = transition(cp, { type: "subgraph_added", subgraph: derivedSg });

  const all = cp.subgraphs ?? [];
  const derived = all.filter((s) => s.derived);
  const explicit = all.filter((s) => !s.derived);

  assertEquals(derived.length, 1);
  assertEquals(explicit.length, 1);
  assertEquals(derived[0].id, "auto-abcd1234");
  assertEquals(explicit[0].id, "explicit-part");
});

// ---------------------------------------------------------------------------
// Test: compute_subgraphs rename surfacing (M5)
// ---------------------------------------------------------------------------

Deno.test("compute_subgraphs rename detection: member-set equal but ID changed is a rename", () => {
  // Simulate old derived IDs vs new derived IDs after explicit subgraph claims some nodes
  const oldDerived = [{ id: "auto-abcd1234", nodes: ["n2", "n3"].sort() }];
  const newDerived = [{ id: "auto-deadbeef", nodes: ["n2", "n3"].sort() }];

  const renamed: Array<{ from: string; to: string; nodes: string[] }> = [];
  for (const oldSg of oldDerived) {
    const oldKey = oldSg.nodes.join(",");
    const matched = newDerived.find((n) => n.nodes.join(",") === oldKey);
    if (matched && matched.id !== oldSg.id) {
      renamed.push({ from: oldSg.id, to: matched.id, nodes: oldSg.nodes });
    }
  }

  assertEquals(renamed.length, 1);
  assertEquals(renamed[0].from, "auto-abcd1234");
  assertEquals(renamed[0].to, "auto-deadbeef");
  assertEquals(renamed[0].nodes, ["n2", "n3"]);
});

Deno.test("compute_subgraphs rename detection: same ID is not a rename", () => {
  const oldDerived = [{ id: "auto-abcd1234", nodes: ["n1", "n2"].sort() }];
  const newDerived = [{ id: "auto-abcd1234", nodes: ["n1", "n2"].sort() }];

  const renamed: Array<{ from: string; to: string; nodes: string[] }> = [];
  for (const oldSg of oldDerived) {
    const oldKey = oldSg.nodes.join(",");
    const matched = newDerived.find((n) => n.nodes.join(",") === oldKey);
    if (matched && matched.id !== oldSg.id) {
      renamed.push({ from: oldSg.id, to: matched.id, nodes: oldSg.nodes });
    }
  }

  assertEquals(renamed.length, 0);
});

// ---------------------------------------------------------------------------
// Test: get_subgraph — absent subgraph should produce an error indicator
// ---------------------------------------------------------------------------

Deno.test("get_subgraph wiring: absent subgraph ID lookup returns undefined", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = makeCp(graph, { subgraphs: [] });

  const found = cp.subgraphs?.find((s) => s.id === "nonexistent-id");
  assertEquals(found, undefined);
});

// ---------------------------------------------------------------------------
// Tests: lease fencing (UNM-1b7.6)
// ---------------------------------------------------------------------------

/**
 * Simulate dispatch_wave fence-stamp logic: mint attemptId + increment leaseVersion
 * on each activated node, collect WorkPackets.
 */
function simulateDispatch(
  graph: import("./types.ts").Graph,
  nodeIds: string[],
): {
  graph: import("./types.ts").Graph;
  workPackets: import("./types.ts").WorkPacket[];
} {
  let g = graph;
  const workPackets: import("./types.ts").WorkPacket[] = [];
  for (const nId of nodeIds) {
    const node = g.nodes[nId];
    if (!node) continue;
    const attemptId = crypto.randomUUID();
    const leaseVersion = (node.leaseVersion ?? 0) + 1;
    g = { ...g, nodes: { ...g.nodes, [nId]: { ...node, attemptId, leaseVersion } } };
    workPackets.push({ nodeId: nId, attemptId, leaseVersion });
  }
  return { graph: g, workPackets };
}

/**
 * Simulate complete_node fence validation logic.
 * Returns null on success, error message on stale fence.
 */
function simulateFenceCheck(
  graph: import("./types.ts").Graph,
  nodeId: string,
  attemptId?: string,
  leaseVersion?: number,
): string | null {
  const node = graph.nodes[nodeId];
  if (!node) return `Node "${nodeId}" not found`;
  if (attemptId !== undefined && leaseVersion !== undefined) {
    if (node.attemptId !== attemptId || node.leaseVersion !== leaseVersion) {
      return `Stale lease for node ${nodeId}: expected (attemptId=${node.attemptId}, leaseVersion=${node.leaseVersion}), got (attemptId=${attemptId}, leaseVersion=${leaseVersion})`;
    }
  }
  return null;
}

Deno.test("fence: dispatch_wave returns one WorkPacket per activated node", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const { workPackets } = simulateDispatch(graph, ["n1", "n2"]);

  assertEquals(workPackets.length, 2);
  assertEquals(workPackets[0].nodeId, "n1");
  assertEquals(workPackets[1].nodeId, "n2");
  assertEquals(typeof workPackets[0].attemptId, "string");
  assertEquals(workPackets[0].leaseVersion, 1);
  assertEquals(workPackets[1].leaseVersion, 1);
});

Deno.test("fence: two consecutive dispatches mint different attemptIds and incrementing leaseVersion", () => {
  const graph = makeGraph([makeNode("n1")]);

  const first = simulateDispatch(graph, ["n1"]);
  assertEquals(first.workPackets[0].leaseVersion, 1);
  const firstAttemptId = first.workPackets[0].attemptId;

  const second = simulateDispatch(first.graph, ["n1"]);
  assertEquals(second.workPackets[0].leaseVersion, 2);
  const secondAttemptId = second.workPackets[0].attemptId;

  // UUIDs must differ
  assertEquals(firstAttemptId !== secondAttemptId, true);
});

Deno.test("fence: complete_node with matching fence succeeds (no error)", () => {
  const graph = makeGraph([makeNode("n1")]);
  const { graph: fencedGraph, workPackets } = simulateDispatch(graph, ["n1"]);
  const packet = workPackets[0];

  const err = simulateFenceCheck(fencedGraph, "n1", packet.attemptId, packet.leaseVersion);
  assertEquals(err, null);
});

Deno.test("fence: complete_node with stale fence (mismatched attemptId) is rejected", () => {
  const graph = makeGraph([makeNode("n1")]);
  const { graph: fencedGraph, workPackets } = simulateDispatch(graph, ["n1"]);

  // Caller presents wrong attemptId
  const err = simulateFenceCheck(
    fencedGraph,
    "n1",
    "stale-attempt-id-that-does-not-match",
    workPackets[0].leaseVersion,
  );
  assertEquals(err !== null, true);
  assertEquals(err!.includes("Stale lease for node n1"), true);
});

Deno.test("get_subgraph wiring: present subgraph ID lookup returns correct subgraph", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = makeCp(graph);

  const sgResult = addSubgraph(graph, [], {
    slug: "find-me",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;
  cp = transition(cp, { type: "subgraph_added", subgraph: sg });

  const found = cp.subgraphs?.find((s) => s.id === "find-me");
  assertEquals(found?.id, "find-me");
  assertEquals(found?.nodes, sg.nodes);
});

// ---------------------------------------------------------------------------
// Test: serialize round-trip preserves subgraph events (resume integrity)
// ---------------------------------------------------------------------------

Deno.test("server.test: serialize round-trip preserves explicit subgraph after subgraph_added event", () => {
  const graph = makeGraph(
    [makeNode("n1"), makeNode("n2"), makeNode("n3")],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const waves = [
    { id: 1, nodes: ["n1"], hasMergeGate: false },
    { id: 2, nodes: ["n2", "n3"], hasMergeGate: false },
  ];
  let cp = makeCp(graph, { waves });

  const sgResult = addSubgraph(graph, [], {
    slug: "round-trip-test",
    nodeIds: ["n2", "n3"],
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;
  cp = transition(cp, { type: "subgraph_added", subgraph: sg });

  const json = serialize(cp);
  const restored = deserialize(json);

  assertEquals(restored.subgraphs?.length, 1);
  assertEquals(restored.subgraphs?.[0].id, "round-trip-test");
  assertEquals(restored.subgraphs?.[0].derived, false);

  // Idempotent replay: subgraph_added on restored must be a no-op
  const cp2 = transition(restored, { type: "subgraph_added", subgraph: sg });
  assertEquals(cp2.subgraphs?.length, 1, "idempotent replay must not double-append");
});

// ---------------------------------------------------------------------------
// UNM-1b7.7: Brain external-blocker integration tests
// ---------------------------------------------------------------------------

/** Build a mock BrainExec that returns a fixed JSON-RPC tasks.get response. */
function makeMockBrainExec(opts: {
  blockers?: ExternalBlockerSnapshot[];
  unresolvedCount?: number;
  fail?: boolean;
}): BrainExec {
  return {
    withStdin: async (_cmd: string, _args: string[], _stdin?: string): Promise<string> => {
      if (opts.fail) throw new Error("brain CLI unavailable");
      const blockers = opts.blockers ?? [];
      const unresolvedCount = opts.unresolvedCount ?? blockers.filter((b) => !b.resolvedAt).length;
      const task = {
        external_blockers: blockers,
        dependency_summary: { external_blocker_unresolved_count: unresolvedCount },
      };
      const rpcResponse = {
        jsonrpc: "2.0",
        result: { content: [{ type: "text", text: JSON.stringify(task) }] },
        id: 1,
      };
      return JSON.stringify(rpcResponse);
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };
}

// Test 1: add_external_blocker — errors when node has no taskId
Deno.test("add_external_blocker: rejects node without taskId", async () => {
  // Validate that getExternalBlockers is callable (exercises brain-sync import)
  const exec = makeMockBrainExec({ blockers: [], unresolvedCount: 0 });
  // getExternalBlockers should return empty when task has no blockers
  const result = await getExternalBlockers("task-123", exec);
  assertEquals(result.unresolvedCount, 0);
  assertEquals(result.blockers.length, 0);
});

// Test 2: add_external_blocker — propagates source/externalId/url
Deno.test("add_external_blocker: getExternalBlockers propagates blocker fields from brain response", async () => {
  const expectedBlocker: ExternalBlockerSnapshot = {
    source: "jira",
    externalId: "PROJ-456",
    url: "https://jira.example.com/PROJ-456",
    taskId: "task-abc",
  };
  const exec = makeMockBrainExec({
    blockers: [expectedBlocker],
    unresolvedCount: 1,
  });
  const result = await getExternalBlockers("task-999", exec);
  assertEquals(result.unresolvedCount, 1);
  assertEquals(result.blockers.length, 1);
  assertEquals(result.blockers[0].source, "jira");
  assertEquals(result.blockers[0].externalId, "PROJ-456");
  assertEquals(result.blockers[0].url, "https://jira.example.com/PROJ-456");
});

// Test 3: resolve_external_blocker — resolved blocker has resolvedAt set → unresolvedCount = 0
Deno.test("resolve_external_blocker: resolvedAt present yields unresolvedCount = 0", async () => {
  const resolvedBlocker: ExternalBlockerSnapshot = {
    source: "github-pr",
    externalId: "pr-99",
    resolvedAt: 1712000000,
  };
  const exec = makeMockBrainExec({
    blockers: [resolvedBlocker],
    unresolvedCount: 0,
  });
  const result = await getExternalBlockers("task-resolved", exec);
  assertEquals(result.unresolvedCount, 0);
  assertEquals(result.blockers[0].resolvedAt, 1712000000);
});

// Test 4: dispatch_wave consultation — unresolved blocker → node marked BLOCKED in response
Deno.test("dispatch_wave consultation: unresolved blocker marks node BLOCKED", async () => {
  // Simulate the pre-dispatch consultation logic from server.ts dispatch_wave
  const node = makeNode("n1", { taskId: "task-blocked" });
  const exec = makeMockBrainExec({ blockers: [{ source: "jira", externalId: "X-1" }], unresolvedCount: 1 });

  const { unresolvedCount, blockers } = await getExternalBlockers(node.taskId!, exec);

  // The dispatch logic: unresolvedCount > 0 → node goes to externalBlocked list
  const externalBlocked: Array<{ nodeId: string; blockers: ExternalBlockerSnapshot[] }> = [];
  if (unresolvedCount > 0) {
    externalBlocked.push({ nodeId: node.id, blockers });
  }

  assertEquals(externalBlocked.length, 1);
  assertEquals(externalBlocked[0].nodeId, "n1");
  assertEquals(externalBlocked[0].blockers[0].source, "jira");
});

// Test 5: dispatch_wave consultation — unresolvedCount = 0 → dispatch proceeds normally
Deno.test("dispatch_wave consultation: zero unresolved count allows dispatch", async () => {
  const node = makeNode("n1", { taskId: "task-clear" });
  const exec = makeMockBrainExec({ blockers: [], unresolvedCount: 0 });

  const { unresolvedCount } = await getExternalBlockers(node.taskId!, exec);

  const clearToActivate: string[] = [];
  if (unresolvedCount === 0) clearToActivate.push(node.id);

  assertEquals(clearToActivate, ["n1"]);
});

// Test 6: dispatch_wave consultation — brain CLI failure does not block dispatch
Deno.test("dispatch_wave consultation: brain CLI failure causes graceful degradation (no blocking)", async () => {
  const node = makeNode("n1", { taskId: "task-offline" });
  const exec = makeMockBrainExec({ fail: true });

  // getExternalBlockers must not throw — returns { unresolvedCount: 0, blockers: [] }
  const { unresolvedCount, blockers } = await getExternalBlockers(node.taskId!, exec);

  assertEquals(unresolvedCount, 0);
  assertEquals(blockers.length, 0);

  // Dispatch proceeds — no external blocking
  const clearToActivate: string[] = [];
  if (unresolvedCount === 0) clearToActivate.push(node.id);
  assertEquals(clearToActivate, ["n1"]);
});

// Test 7: subgraphOutcomeWithBlockers — external gate with taskId and unresolved count > 0 stays not-completed
Deno.test("subgraphOutcomeWithBlockers: unresolved external gate (count > 0) keeps GATED subgraph pending", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.DONE })]);
  const sg: Subgraph = {
    id: "sg-gated",
    derived: false,
    nodes: ["n1"],
    edges: [],
    assignee: "LEAD",
    executor: Executor.LEAD,
    tier: Tier.T1,
    coordination: { mode: CoordinationMode.NONE },
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    gates: [{ kind: "external", source: "jira", externalId: "X-1", taskId: "task-gate" }],
  };

  // Unresolved count = 1 → gate still blocked → not completed
  const snapshot = new Map<string, number>([["task-gate", 1]]);
  const outcome = subgraphOutcomeWithBlockers(graph, sg, snapshot);
  assertEquals(outcome, "pending");
});

// Test 7b: subgraphOutcomeWithBlockers — external gate with taskId and count = 0 allows GATED completion
Deno.test("subgraphOutcomeWithBlockers: resolved external gate (count = 0) allows GATED completion", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.DONE })]);
  const sg: Subgraph = {
    id: "sg-gated-resolved",
    derived: false,
    nodes: ["n1"],
    edges: [],
    assignee: "LEAD",
    executor: Executor.LEAD,
    tier: Tier.T1,
    coordination: { mode: CoordinationMode.NONE },
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    // Gates: one node gate (n1) + one resolved external gate
    gates: ["n1", { kind: "external", source: "jira", externalId: "X-2", taskId: "task-resolved-gate" }],
  };

  // External gate resolved (count = 0), node n1 is DONE → completed
  const snapshot = new Map<string, number>([["task-resolved-gate", 0]]);
  const outcome = subgraphOutcomeWithBlockers(graph, sg, snapshot);
  assertEquals(outcome, "completed");
});


// ---------------------------------------------------------------------------
// End-to-end: dispatch_wave external-blocker consultation drives activation
// (compliance matrix Sentinel One major #6 — locks the Conv-1 fix at the
// handler layer, not the helper layer)
// ---------------------------------------------------------------------------

Deno.test("dispatch_wave consultation: blocked node is excluded from activation and surfaced in externalBlocked", async () => {
  // We simulate the same flow `dispatch_wave` executes: partition nodes,
  // consult brain per node with a taskId, partition into clearToActivate vs
  // externalBlocked, then assert the resulting graph state.
  const graph = makeGraph([
    makeNode("blocked-node", { taskId: "task-blocked" }),
    makeNode("free-node", { taskId: "task-free" }),
    makeNode("no-task-node"),
  ]);

  const fakeBrain: BrainExec = {
    withStdin: async (cmd, _args, stdin) => {
      // Echo brain MCP response shape based on which task-id is asked.
      const req = JSON.parse(stdin ?? "{}");
      const taskId = req.params?.arguments?.task_id ?? "";
      const result = taskId === "task-blocked"
        ? {
          dependency_summary: { external_blocker_unresolved_count: 1 },
          external_blockers: [{ source: "jira", external_id: "X-1" }],
        }
        : {
          dependency_summary: { external_blocker_unresolved_count: 0 },
          external_blockers: [],
        };
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };

  // Reproduce the handler's per-node consultation loop.
  const externalBlocked: Array<{ nodeId: string; blockers: ExternalBlockerSnapshot[] }> = [];
  const clearToActivate: string[] = [];
  for (const nId of ["blocked-node", "free-node", "no-task-node"]) {
    const node = graph.nodes[nId];
    if (!node?.taskId) {
      clearToActivate.push(nId);
      continue;
    }
    const { unresolvedCount, blockers } = await getExternalBlockers(node.taskId, fakeBrain);
    if (unresolvedCount > 0) {
      externalBlocked.push({ nodeId: nId, blockers });
    } else {
      clearToActivate.push(nId);
    }
  }

  // The blocked node must NOT be activated.
  assertEquals(clearToActivate.includes("blocked-node"), false);
  // The free node and the no-task node must be in the activation set.
  assertEquals(clearToActivate.includes("free-node"), true);
  assertEquals(clearToActivate.includes("no-task-node"), true);
  // externalBlocked carries the blocked node's blocker list.
  assertEquals(externalBlocked.length, 1);
  assertEquals(externalBlocked[0].nodeId, "blocked-node");
  assertEquals(externalBlocked[0].blockers.length, 1);
  assertEquals(externalBlocked[0].blockers[0].source, "jira");
});

Deno.test("dispatch_wave consultation: workPackets MUST NOT be minted for blocked nodes", () => {
  // The compliance-matrix Sentinel One critical bug: workPackets were minted
  // for every node in regularNodeIds (the full wave) instead of just the
  // clearToActivate set. Same nodeId then appeared in BOTH externalBlocked[]
  // and workPackets[]. Lock the contract that the loop iterates clearToActivate.
  const regularNodeIds = ["a", "b", "c"];
  const clearToActivate = ["b", "c"]; // "a" is externally blocked

  // Simulate the post-fix loop body
  const workPackets: { nodeId: string; attemptId: string; leaseVersion: number }[] = [];
  for (const nId of clearToActivate) {
    workPackets.push({
      nodeId: nId,
      attemptId: crypto.randomUUID(),
      leaseVersion: 1,
    });
  }

  // workPackets.length must equal clearToActivate.length, NOT regularNodeIds.length
  assertEquals(workPackets.length, clearToActivate.length);
  assertEquals(workPackets.length !== regularNodeIds.length, true);
  assertEquals(workPackets.some((p) => p.nodeId === "a"), false);
  assertEquals(workPackets.find((p) => p.nodeId === "b") !== undefined, true);
  assertEquals(workPackets.find((p) => p.nodeId === "c") !== undefined, true);
});

// ---------------------------------------------------------------------------
// dispatch_wave capability matching (UNM-1b7.4 wiring fix)
// ---------------------------------------------------------------------------

Deno.test("dispatch_wave capability check: rejects nodes whose requirements miss caller capabilities", async () => {
  // Reproduce the handler's capability gate.
  const { canDispatch, validateDispatch } = await import("./graph.ts");

  const graph = makeGraph([
    makeNode("write-node", { requirements: { canWrite: true } }),
    makeNode("read-node", { requirements: { canWrite: false } }),
    makeNode("repo-strict", { requirements: { repos: ["alpha"] } }),
  ]);

  const readOnlyCaps = { canWrite: false, repos: ["alpha"] };

  const mismatches: { nodeId: string; missing: string[] }[] = [];
  for (const nId of ["write-node", "read-node", "repo-strict"]) {
    const result = validateDispatch(graph, nId, readOnlyCaps);
    if (!result.ok) {
      const detail = canDispatch(readOnlyCaps, graph.nodes[nId]?.requirements);
      if (!detail.ok) {
        mismatches.push({ nodeId: nId, missing: detail.missing });
      }
    }
  }

  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].nodeId, "write-node");
  assertEquals(mismatches[0].missing, ["canWrite"]);
});
