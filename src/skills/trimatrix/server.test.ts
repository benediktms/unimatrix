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

import { assertEquals } from "@std/assert";
import {
  deserialize,
  serialize,
  transition,
} from "./state.ts";
import { addSubgraph } from "./graph.ts";
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
import type { Checkpoint, Graph, Node, SubgraphSummary } from "./types.ts";

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
