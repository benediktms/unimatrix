/**
 * Tests for the trimatrix graph engine (graph.ts).
 *
 * Covers: validate, computeWaves, nextWave, completeNode, failNode,
 * clearGate, waveStatus, activateNodes, addNode, addEdge,
 * computeWavesFromRefinement.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  activateNodes,
  addEdge,
  addNode,
  addSubgraph,
  canDispatch,
  clearGate,
  completeNode,
  computeSubgraphs,
  computeWaves,
  computeWavesFromRefinement,
  currentFrontier,
  failNode,
  nextFrontierBatch,
  nextWave,
  parallelNodesInWave,
  serializeSubgraphBrief,
  subgraphOutcome,
  unsatisfiedDependencies,
  updateNode,
  validate,
  validateDispatch,
  waveStatus,
} from "./graph.ts";
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
import type { Capabilities, Graph, Node, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "n",
    repo: "repo-a",
    type: NodeType.IMPLEMENTATION,
    label: "Node",
    worktreeBranch: "trimatrix/n",
    status: NodeStatus.PENDING,
    executor: Executor.LEAD,
    ...overrides,
  };
}

function makeGraph(
  nodes: Node[],
  edges: Graph["edges"] = [],
): Graph {
  const nodeMap: Graph["nodes"] = {};
  for (const n of nodes) {
    nodeMap[n.id] = n;
  }
  return { nodes: nodeMap, edges };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

Deno.test("validate: valid simple chain A→B→C (MERGE_GATE)", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const result = validate(g);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("validate: valid parallel — A and B independent, both → C", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "C", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const result = validate(g);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("validate: cycle detection A→B→C→A", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
      { from: "C", to: "A", type: EdgeType.MERGE_GATE },
    ],
  );
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length > 0, true);
});

Deno.test("validate: self-reference A→A", () => {
  const g = makeGraph(
    [makeNode({ id: "A" })],
    [{ from: "A", to: "A", type: EdgeType.MERGE_GATE }],
  );
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) => e.includes("Self-referencing")),
    true,
  );
});

Deno.test("validate: missing node reference in edge", () => {
  const g = makeGraph(
    [makeNode({ id: "A" })],
    [{ from: "A", to: "MISSING", type: EdgeType.MERGE_GATE }],
  );
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) => e.includes("MISSING")),
    true,
  );
});

Deno.test("validate: empty graph is valid", () => {
  const g = makeGraph([]);
  const result = validate(g);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

// ---------------------------------------------------------------------------
// computeWaves
// ---------------------------------------------------------------------------

Deno.test("computeWaves: linear chain A→B→C (MERGE_GATE) — 3 waves", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 3);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes, ["B"]);
  assertEquals(waves[2].nodes, ["C"]);
  // Waves 0 and 1 each have outgoing MERGE_GATE edges
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, true);
  assertEquals(waves[2].hasMergeGate, false);
});

Deno.test("computeWaves: parallel independence — 1 wave", () => {
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
    makeNode({ id: "C" }),
  ]);
  const waves = computeWaves(g);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes.sort(), ["A", "B", "C"]);
  assertEquals(waves[0].hasMergeGate, false);
});

Deno.test("computeWaves: fan-out after gate — wave 1:[A], wave 2:[B,C]", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "A", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 2);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes.sort(), ["B", "C"]);
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, false);
});

Deno.test("computeWaves: stacked same-repo — both in same wave", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", repo: "repo-x" }),
      makeNode({ id: "B", repo: "repo-x", stackedOn: "A" }),
    ],
    [{ from: "A", to: "B", type: EdgeType.STACKED }],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes.sort(), ["A", "B"]);
  assertEquals(waves[0].hasMergeGate, false);
});

Deno.test("computeWaves: mixed stacked and merge_gate", () => {
  // A and B are stacked (same wave). C gates on A (MERGE_GATE → next wave).
  const g = makeGraph(
    [
      makeNode({ id: "A", repo: "repo-x" }),
      makeNode({ id: "B", repo: "repo-x", stackedOn: "A" }),
      makeNode({ id: "C", repo: "repo-y" }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.STACKED },
      { from: "A", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 2);
  // Wave 0: A and B (stacked, no gate boundary)
  assertEquals(waves[0].nodes.sort(), ["A", "B"]);
  // Wave 1: C (gated on A's merge)
  assertEquals(waves[1].nodes, ["C"]);
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, false);
});

Deno.test("computeWaves: diamond dependency A→B, A→C, B→D, C→D", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A" }),
      makeNode({ id: "B" }),
      makeNode({ id: "C" }),
      makeNode({ id: "D" }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "A", to: "C", type: EdgeType.MERGE_GATE },
      { from: "B", to: "D", type: EdgeType.MERGE_GATE },
      { from: "C", to: "D", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 3);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes.sort(), ["B", "C"]);
  assertEquals(waves[2].nodes, ["D"]);
});

Deno.test("computeWaves: DEPENDS_ON creates wave boundary (2 waves)", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" })],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 2);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes, ["B"]);
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, false);
});

Deno.test("computeWaves: DEPENDS_ON + STACKED mixed", () => {
  // A and B are stacked (same wave). C depends_on A (next wave).
  const g = makeGraph(
    [
      makeNode({ id: "A" }),
      makeNode({ id: "B", stackedOn: "A" }),
      makeNode({ id: "C" }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.STACKED },
      { from: "A", to: "C", type: EdgeType.DEPENDS_ON },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 2);
  assertEquals(waves[0].nodes.sort(), ["A", "B"]);
  assertEquals(waves[1].nodes, ["C"]);
  assertEquals(waves[0].hasMergeGate, true);
});

Deno.test("computeWaves: DEPENDS_ON + MERGE_GATE mixed", () => {
  // A→B (MERGE_GATE) and A→C (DEPENDS_ON): both B and C go to wave 2.
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "A", to: "C", type: EdgeType.DEPENDS_ON },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 2);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes.sort(), ["B", "C"]);
  assertEquals(waves[0].hasMergeGate, true);
});

// ---------------------------------------------------------------------------
// nextWave
// ---------------------------------------------------------------------------

Deno.test("nextWave: first wave (currentWaveId null → wave 1)", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const waves = computeWaves(g);
  const next = nextWave(g, waves, null);
  assertEquals(next?.id, 1);
});

Deno.test("nextWave: wave 1 with intra-wave stacked edge (currentWaveId null)", () => {
  // Reproduces the bug: stacked nodes in wave 1, both pending, currentWaveId null.
  // nextWave must return wave 1 — intra-wave stacked edges do not block dispatch.
  const g = makeGraph(
    [
      makeNode({ id: "A", repo: "repo-x" }),
      makeNode({ id: "B", repo: "repo-x", stackedOn: "A" }),
    ],
    [{ from: "A", to: "B", type: EdgeType.STACKED }],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes.sort(), ["A", "B"]);
  const next = nextWave(g, waves, null);
  assertEquals(next?.id, 1);
  assertEquals(next?.nodes.sort(), ["A", "B"]);
});

Deno.test("nextWave: gate not cleared → returns null", () => {
  // A must be merged before B can start (MERGE_GATE).
  // A is only PR_CREATED, not merged → gate not satisfied.
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.PR_CREATED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.MERGE_GATE }],
  );
  const waves = computeWaves(g);
  // currentWaveId = 1 (wave 1 is active)
  const next = nextWave(g, waves, 1);
  assertEquals(next, null);
});

Deno.test("nextWave: gate cleared (A merged) → returns wave 2", () => {
  // A merged with prUrl → B's MERGE_GATE dependency is satisfied.
  const g = makeGraph(
    [
      makeNode({
        id: "A",
        status: NodeStatus.MERGED,
        prUrl: "https://github.com/o/r/pull/1",
        prNumber: 1,
      }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.MERGE_GATE }],
  );
  const waves = computeWaves(g);
  const next = nextWave(g, waves, 1);
  assertEquals(next?.id, 2);
  assertEquals(next?.nodes, ["B"]);
});

Deno.test("nextWave: all waves done → returns null", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.MERGED })]);
  const waves = computeWaves(g);
  // currentWaveId = 1, wave 1 is the last wave
  const next = nextWave(g, waves, 1);
  assertEquals(next, null);
});

Deno.test("nextWave: depends_on satisfied by DONE", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.DONE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  const next = nextWave(g, waves, 1);
  assertEquals(next?.id, 2);
  assertEquals(next?.nodes, ["B"]);
});

Deno.test("nextWave: depends_on satisfied by MERGED", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  const next = nextWave(g, waves, 1);
  assertEquals(next?.id, 2);
  assertEquals(next?.nodes, ["B"]);
});

Deno.test("nextWave: depends_on NOT satisfied by ACTIVE", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.ACTIVE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  const next = nextWave(g, waves, 1);
  assertEquals(next, null);
});

Deno.test("nextWave: wave completion includes DONE nodes", () => {
  // Wave with one DONE node — should count as completed
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.DONE })]);
  const waves = computeWaves(g);
  const next = nextWave(g, waves, 1);
  assertEquals(next, null); // wave is completed, no next wave
});

// ---------------------------------------------------------------------------
// completeNode, failNode, clearGate — immutability checks
// ---------------------------------------------------------------------------

Deno.test("completeNode: sets PR_CREATED when node has prUrl", () => {
  const original = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE }),
  ]);
  // Attach PR metadata first via updateNode
  const withPr = updateNode(original, "A", {
    prUrl: "https://gh.example/pr/1",
    prNumber: 1,
  });
  const updated = completeNode(withPr, "A");
  assertEquals(updated.nodes["A"].status, NodeStatus.PR_CREATED);
  assertEquals(updated.nodes["A"].prUrl, "https://gh.example/pr/1");
  assertEquals(updated.nodes["A"].prNumber, 1);
  // Original is not mutated
  assertEquals(original.nodes["A"].status, NodeStatus.ACTIVE);
});

Deno.test("completeNode: with repo, no PR → MERGED", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE, repo: "repo-a" }),
  ]);
  const updated = completeNode(g, "A");
  assertEquals(updated.nodes["A"].status, NodeStatus.MERGED);
});

Deno.test("completeNode: repo-less → DONE", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE, repo: undefined }),
  ]);
  // Remove repo to test single-repo path
  g.nodes["A"] = { ...g.nodes["A"] };
  delete (g.nodes["A"] as Partial<Node>).repo;
  const updated = completeNode(g, "A");
  assertEquals(updated.nodes["A"].status, NodeStatus.DONE);
});

Deno.test("completeNode: repo-less with prUrl → PR_CREATED", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE }),
  ]);
  delete (g.nodes["A"] as Partial<Node>).repo;
  const withPr = updateNode(g, "A", {
    prUrl: "https://gh.example/pr/2",
    prNumber: 2,
  });
  const updated = completeNode(withPr, "A");
  assertEquals(updated.nodes["A"].status, NodeStatus.PR_CREATED);
});

Deno.test("updateNode: patches metadata without changing status", () => {
  const original = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE }),
  ]);
  const updated = updateNode(original, "A", {
    prUrl: "https://gh.example/pr/3",
    prNumber: 3,
  });
  assertEquals(updated.nodes["A"].status, NodeStatus.ACTIVE);
  assertEquals(updated.nodes["A"].prUrl, "https://gh.example/pr/3");
  assertEquals(updated.nodes["A"].prNumber, 3);
  // Original is not mutated
  assertEquals(original.nodes["A"].prUrl, undefined);
});

Deno.test("updateNode: throws on missing node", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.ACTIVE })]);
  assertThrows(
    () => updateNode(g, "NONEXISTENT", { prUrl: "https://gh.example/pr/1" }),
    Error,
    "not found",
  );
});

Deno.test("failNode: sets FAILED status and failureReason", () => {
  const original = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE }),
  ]);
  const updated = failNode(original, "A", "build error");
  assertEquals(updated.nodes["A"].status, NodeStatus.FAILED);
  assertEquals(updated.nodes["A"].failureReason, "build error");
  // Original is not mutated
  assertEquals(original.nodes["A"].status, NodeStatus.ACTIVE);
});

Deno.test("clearGate: sets ACTIVE status and clears failureReason", () => {
  const original = makeGraph([
    makeNode({ id: "A", status: NodeStatus.BLOCKED, failureReason: "gate" }),
  ]);
  const updated = clearGate(original, "A");
  assertEquals(updated.nodes["A"].status, NodeStatus.ACTIVE);
  assertEquals(updated.nodes["A"].failureReason, undefined);
  // Original is not mutated
  assertEquals(original.nodes["A"].status, NodeStatus.BLOCKED);
});

// ---------------------------------------------------------------------------
// waveStatus
// ---------------------------------------------------------------------------

function makeWave(id: number, nodes: string[]): Wave {
  return { id, nodes, hasMergeGate: false };
}

Deno.test("waveStatus: all nodes MERGED → completed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.MERGED }),
    makeNode({ id: "B", status: NodeStatus.MERGED }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "completed");
});

Deno.test("waveStatus: all DONE → completed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.DONE }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "completed");
});

Deno.test("waveStatus: mixed DONE and MERGED → completed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.MERGED }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "completed");
});

Deno.test("waveStatus: one MERGED, one FAILED → partial_failure", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.MERGED }),
    makeNode({ id: "B", status: NodeStatus.FAILED }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "partial_failure");
});

Deno.test("waveStatus: all nodes failed → failed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.FAILED }),
    makeNode({ id: "B", status: NodeStatus.BLOCKED }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "failed");
});

Deno.test("waveStatus: at least one ACTIVE, none failed → active", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "active");
});

Deno.test("waveStatus: all nodes PENDING → pending", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "pending");
});

// ---------------------------------------------------------------------------
// activateNodes
// ---------------------------------------------------------------------------

Deno.test("activateNodes: transitions pending nodes to ACTIVE", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
  ]);
  const updated = activateNodes(g, ["A", "B"]);
  assertEquals(updated.nodes["A"].status, NodeStatus.ACTIVE);
  assertEquals(updated.nodes["B"].status, NodeStatus.ACTIVE);
  // Original is not mutated
  assertEquals(g.nodes["A"].status, NodeStatus.PENDING);
});

Deno.test("activateNodes: ignores non-existent node IDs", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.PENDING })]);
  const updated = activateNodes(g, ["A", "MISSING"]);
  assertEquals(updated.nodes["A"].status, NodeStatus.ACTIVE);
  assertEquals(updated.nodes["MISSING"], undefined);
});

Deno.test("activateNodes: partial activation — only specified nodes", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
  ]);
  const updated = activateNodes(g, ["A"]);
  assertEquals(updated.nodes["A"].status, NodeStatus.ACTIVE);
  assertEquals(updated.nodes["B"].status, NodeStatus.PENDING);
});

// ---------------------------------------------------------------------------
// addNode
// ---------------------------------------------------------------------------

Deno.test("addNode: adds node to empty graph (non-refining)", () => {
  const g = makeGraph([]);
  const result = addNode(g, makeNode({ id: "A" }));
  assertEquals(result.ok, true);
  assertEquals(result.value!.nodes["A"].id, "A");
});

Deno.test("addNode: non-refining allows duplicate ID (overwrites)", () => {
  const g = makeGraph([makeNode({ id: "A", label: "old" })]);
  const result = addNode(g, makeNode({ id: "A", label: "new" }));
  assertEquals(result.ok, true);
  assertEquals(result.value!.nodes["A"].label, "new");
});

Deno.test("addNode: refining rejects duplicate ID", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addNode(g, makeNode({ id: "A" }), true);
  assertEquals(result.ok, false);
  assertEquals(result.error!.includes("already exists"), true);
});

Deno.test("addNode: refining rejects stackedOn pointing to ACTIVE node", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.ACTIVE })]);
  const result = addNode(
    g,
    makeNode({ id: "B", stackedOn: "A" }),
    true,
  );
  assertEquals(result.ok, false);
  assertEquals(result.error!.includes("ACTIVE"), true);
});

Deno.test("addNode: refining rejects stackedOn pointing to MERGED node", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.MERGED })]);
  const result = addNode(
    g,
    makeNode({ id: "B", stackedOn: "A" }),
    true,
  );
  assertEquals(result.ok, false);
  assertEquals(result.error!.includes("MERGED"), true);
});

Deno.test("addNode: refining allows stackedOn pointing to PENDING node", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.PENDING })]);
  const result = addNode(
    g,
    makeNode({ id: "B", stackedOn: "A" }),
    true,
  );
  assertEquals(result.ok, true);
  assertEquals(result.value!.nodes["B"].stackedOn, "A");
});

Deno.test("addNode: tags preserved", () => {
  const g = makeGraph([]);
  const node = makeNode({ id: "A", tags: ["alpha", "beta"] });
  const result = addNode(g, node);
  assertEquals(result.ok, true);
  assertEquals(result.value!.nodes["A"].tags, ["alpha", "beta"]);
});

// ---------------------------------------------------------------------------
// addEdge
// ---------------------------------------------------------------------------

Deno.test("addEdge: adds MERGE_GATE edge (non-refining)", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const result = addEdge(g, { from: "A", to: "B", type: EdgeType.MERGE_GATE });
  assertEquals(result.ok, true);
  assertEquals(result.value!.edges.length, 1);
  assertEquals(result.value!.edges[0].from, "A");
});

Deno.test("addEdge: refining rejects edge to ACTIVE node", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.ACTIVE }),
  ]);
  const result = addEdge(
    g,
    { from: "A", to: "B", type: EdgeType.MERGE_GATE },
    true,
  );
  assertEquals(result.ok, false);
  assertEquals(result.error!.includes("ACTIVE"), true);
});

Deno.test("addEdge: refining rejects edge to MERGED node", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.MERGED }),
  ]);
  const result = addEdge(
    g,
    { from: "A", to: "B", type: EdgeType.MERGE_GATE },
    true,
  );
  assertEquals(result.ok, false);
  assertEquals(result.error!.includes("MERGED"), true);
});

Deno.test("addEdge: refining allows edge to PENDING node", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
  ]);
  const result = addEdge(
    g,
    { from: "A", to: "B", type: EdgeType.STACKED },
    true,
  );
  assertEquals(result.ok, true);
  assertEquals(result.value!.edges.length, 1);
});

// ---------------------------------------------------------------------------
// computeWavesFromRefinement
// ---------------------------------------------------------------------------

Deno.test("computeWavesFromRefinement: excludes completed nodes", () => {
  // A is MERGED (completed). B and C are pending with B→C MERGE_GATE.
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
      makeNode({ id: "C", status: NodeStatus.PENDING }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWavesFromRefinement(g, 2);
  // A is excluded. B starts at level 0 (its only dep A is completed → pre-satisfied).
  // B→C MERGE_GATE → C at level 1.
  assertEquals(waves.length, 2);
  assertEquals(waves[0].nodes, ["B"]);
  assertEquals(waves[1].nodes, ["C"]);
  // Wave IDs offset by 2
  assertEquals(waves[0].id, 3);
  assertEquals(waves[1].id, 4);
});

Deno.test("computeWavesFromRefinement: all nodes completed → empty waves", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.MERGED }),
    makeNode({ id: "B", status: NodeStatus.MERGED }),
  ]);
  const waves = computeWavesFromRefinement(g, 1);
  assertEquals(waves.length, 0);
});

Deno.test("computeWavesFromRefinement: new independent nodes → single wave", () => {
  // A merged. B and C are new, independent of each other.
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
      makeNode({ id: "C", status: NodeStatus.PENDING }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "A", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWavesFromRefinement(g, 1);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes.sort(), ["B", "C"]);
  assertEquals(waves[0].id, 2);
});

Deno.test("computeWavesFromRefinement: preserves hasMergeGate on remaining edges", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
      makeNode({ id: "C", status: NodeStatus.PENDING }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  );
  const waves = computeWavesFromRefinement(g, 0);
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, false);
});

Deno.test("computeWavesFromRefinement: stacked edges within remaining nodes — same wave", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", repo: "repo-x", status: NodeStatus.PENDING }),
      makeNode({
        id: "C",
        repo: "repo-x",
        status: NodeStatus.PENDING,
        stackedOn: "B",
      }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.MERGE_GATE },
      { from: "B", to: "C", type: EdgeType.STACKED },
    ],
  );
  const waves = computeWavesFromRefinement(g, 1);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes.sort(), ["B", "C"]);
});

Deno.test("computeWavesFromRefinement: DEPENDS_ON edges create boundaries", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
      makeNode({ id: "C", status: NodeStatus.PENDING }),
    ],
    [
      { from: "A", to: "B", type: EdgeType.DEPENDS_ON },
      { from: "B", to: "C", type: EdgeType.DEPENDS_ON },
    ],
  );
  const waves = computeWavesFromRefinement(g, 0);
  assertEquals(waves.length, 2);
  assertEquals(waves[0].nodes, ["B"]);
  assertEquals(waves[1].nodes, ["C"]);
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, false);
});

Deno.test("computeWavesFromRefinement: DONE nodes also excluded", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.DONE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWavesFromRefinement(g, 0);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes, ["B"]);
});

// ---------------------------------------------------------------------------
// computeSubgraphs
// ---------------------------------------------------------------------------

Deno.test("computeSubgraphs: SELF returns single subgraph with all nodes", () => {
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
  ]);
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T1, SubgraphStrategy.SELF);
  assertEquals(sgs.length, 1);
  assertEquals(sgs[0].id, "sg-lead");
  assertEquals(sgs[0].executor, Executor.LEAD);
  assertEquals(sgs[0].assignee, "LEAD");
  assertEquals(sgs[0].coordination.mode, CoordinationMode.NONE);
  assertEquals(sgs[0].nodes.length, 2);
});

Deno.test("computeSubgraphs: INDEPENDENT partitions adjunct and lead nodes", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", executor: Executor.ADJUNCT }),
      makeNode({ id: "B", executor: Executor.ADJUNCT }),
      makeNode({
        id: "C",
        executor: Executor.LEAD,
        type: NodeType.VERIFY_TEST,
      }),
    ],
    // Connect A and B so they form one component
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T2, SubgraphStrategy.INDEPENDENT);

  const leadSg = sgs.find((s) => s.id === "sg-lead");
  const adjunctSg = sgs.find((s) => s.executor === Executor.ADJUNCT);
  assertEquals(leadSg !== undefined, true);
  assertEquals(adjunctSg !== undefined, true);
  assertEquals(leadSg!.executor, Executor.LEAD);
  assertEquals(adjunctSg!.id.startsWith("auto-"), true);
  assertEquals(leadSg!.nodes.includes("C"), true);
  assertEquals(adjunctSg!.nodes.includes("A"), true);
  assertEquals(adjunctSg!.nodes.includes("B"), true);
});

Deno.test("computeSubgraphs: INDEPENDENT keeps VERIFY_COMPILE with adjunct predecessor", () => {
  const g = makeGraph(
    [
      makeNode({ id: "impl", executor: Executor.ADJUNCT }),
      makeNode({
        id: "vc",
        executor: Executor.LEAD,
        type: NodeType.VERIFY_COMPILE,
      }),
      makeNode({
        id: "test",
        executor: Executor.LEAD,
        type: NodeType.VERIFY_TEST,
      }),
    ],
    [{ from: "impl", to: "vc", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T2, SubgraphStrategy.INDEPENDENT);

  const adjunctSg = sgs.find((s) => s.executor === Executor.ADJUNCT);
  const leadSg = sgs.find((s) => s.id === "sg-lead");
  assertEquals(adjunctSg!.nodes.includes("vc"), true);
  assertEquals(leadSg!.nodes.includes("test"), true);
  assertEquals(leadSg!.nodes.includes("vc"), false);
});

Deno.test("computeSubgraphs: INDEPENDENT separates disconnected adjunct components", () => {
  const g = makeGraph([
    makeNode({ id: "A", executor: Executor.ADJUNCT }),
    makeNode({ id: "B", executor: Executor.ADJUNCT }),
  ]);
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T2, SubgraphStrategy.INDEPENDENT);

  const adjunctSgs = sgs.filter((s) => s.executor === Executor.ADJUNCT);
  assertEquals(adjunctSgs.length, 2);
});

Deno.test("computeSubgraphs: COORDINATED adds ADVERSARIAL for read-only subgraphs", () => {
  const g = makeGraph([
    makeNode({ id: "R1", executor: Executor.ADJUNCT, type: NodeType.RECON }),
    makeNode({
      id: "R2",
      executor: Executor.ADJUNCT,
      type: NodeType.VALIDATION,
    }),
  ]);
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T3, SubgraphStrategy.COORDINATED);

  const adjunctSgs = sgs.filter((s) => s.executor === Executor.ADJUNCT);
  for (const sg of adjunctSgs) {
    assertEquals(sg.coordination.mode, CoordinationMode.ADVERSARIAL);
  }
});

Deno.test("computeSubgraphs: COORDINATED adds PARTITIONED for write subgraphs", () => {
  const g = makeGraph([
    makeNode({
      id: "impl",
      executor: Executor.ADJUNCT,
      type: NodeType.IMPLEMENTATION,
    }),
  ]);
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T3, SubgraphStrategy.COORDINATED);

  const adjunctSg = sgs.find((s) => s.executor === Executor.ADJUNCT);
  assertEquals(adjunctSg!.coordination.mode, CoordinationMode.PARTITIONED);
});

Deno.test("computeSubgraphs: empty graph returns empty", () => {
  const g = makeGraph([]);
  const sgs = computeSubgraphs(g, [], Tier.T1, SubgraphStrategy.SELF);
  assertEquals(sgs.length, 0);
});

Deno.test("computeSubgraphs: derived adjunct IDs are stable when siblings change", () => {
  // Graph 1: components {A,B} and {C}
  const g1 = makeGraph(
    [
      makeNode({ id: "A", executor: Executor.ADJUNCT }),
      makeNode({ id: "B", executor: Executor.ADJUNCT }),
      makeNode({ id: "C", executor: Executor.ADJUNCT }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const sgs1 = computeSubgraphs(g1, [], Tier.T2, SubgraphStrategy.INDEPENDENT);
  const ab1 = sgs1.find((s) => s.nodes.includes("A"))!.id;
  const c1 = sgs1.find((s) => s.nodes.includes("C"))!.id;

  // Graph 2: drop the {C} component entirely. Positional IDs would have renumbered
  // the {A,B} component; hash-based IDs must not.
  const g2 = makeGraph(
    [
      makeNode({ id: "A", executor: Executor.ADJUNCT }),
      makeNode({ id: "B", executor: Executor.ADJUNCT }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const sgs2 = computeSubgraphs(g2, [], Tier.T2, SubgraphStrategy.INDEPENDENT);
  const ab2 = sgs2.find((s) => s.nodes.includes("A"))!.id;
  assertEquals(
    ab1,
    ab2,
    "subgraph ID for {A,B} must survive removal of sibling {C}",
  );
  assertEquals(ab1.startsWith("auto-"), true);
  assertEquals(c1.startsWith("auto-"), true);
  assertEquals(ab1 !== c1, true);
});

Deno.test("computeSubgraphs: derived subgraphs carry default policies and derived flag", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", executor: Executor.ADJUNCT }),
    ],
  );
  const sgs = computeSubgraphs(g, [], Tier.T2, SubgraphStrategy.INDEPENDENT);
  assertEquals(sgs.length, 1);
  assertEquals(sgs[0].derived, true);
  assertEquals(sgs[0].completionPolicy, "ALL");
  assertEquals(sgs[0].failurePolicy, "FAIL_FAST");
});

// ---------------------------------------------------------------------------
// addSubgraph
// ---------------------------------------------------------------------------

Deno.test("addSubgraph: creates explicit subgraph with defaults", () => {
  const g = makeGraph([
    makeNode({ id: "A", executor: Executor.ADJUNCT }),
    makeNode({ id: "B", executor: Executor.ADJUNCT }),
  ]);
  const result = addSubgraph(g, [], {
    slug: "auth-rewrite",
    nodeIds: ["A", "B"],
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
  });
  assertEquals(result.ok, true);
  const sg = result.value!;
  assertEquals(sg.id, "auth-rewrite");
  assertEquals(sg.derived, false);
  assertEquals(sg.completionPolicy, "ALL");
  assertEquals(sg.failurePolicy, "FAIL_FAST");
  assertEquals(sg.nodes.length, 2);
});

Deno.test("addSubgraph: rejects invalid slug format", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const cases = ["", "Foo", "1abc", "with space", "trailing-"];
  for (const slug of cases) {
    const result = addSubgraph(g, [], {
      slug,
      nodeIds: ["A"],
      executor: Executor.LEAD,
      tier: Tier.T1,
    });
    assertEquals(result.ok, false, `slug "${slug}" should be rejected`);
  }
});

Deno.test("addSubgraph: rejects reserved slugs", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  for (const slug of ["sg-lead", "auto-deadbeef"]) {
    const result = addSubgraph(g, [], {
      slug,
      nodeIds: ["A"],
      executor: Executor.LEAD,
      tier: Tier.T1,
    });
    assertEquals(result.ok, false);
    assertEquals(result.error?.includes("reserved"), true);
  }
});

Deno.test("addSubgraph: rejects duplicate slug with differing spec", () => {
  // Idempotency: same slug with a DIFFERENT spec must be rejected.
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const first = addSubgraph(g, [], {
    slug: "core",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(first.ok, true);
  // Re-add with different nodeIds — must fail.
  const second = addSubgraph(g, [first.value!], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(second.ok, false);
  assertEquals(second.error?.includes("already exists"), true);
});

Deno.test("addSubgraph: rejects nodes overlapping another explicit subgraph", () => {
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
  ]);
  const first = addSubgraph(g, [], {
    slug: "alpha",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  const second = addSubgraph(g, [first.value!], {
    slug: "beta",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(second.ok, false);
  assertEquals(second.error?.includes("alpha"), true);
});

Deno.test("addSubgraph: allows overlap with derived subgraphs", () => {
  const g = makeGraph([makeNode({ id: "A", executor: Executor.ADJUNCT })]);
  const derived = computeSubgraphs(
    g,
    [],
    Tier.T2,
    SubgraphStrategy.INDEPENDENT,
  );
  assertEquals(derived[0].derived, true);
  const result = addSubgraph(g, derived, {
    slug: "explicit",
    nodeIds: ["A"],
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
  });
  assertEquals(result.ok, true, result.error);
});

Deno.test("addSubgraph: rejects non-existent node", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "ghost",
    nodeIds: ["A", "missing"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("missing"), true);
});

Deno.test("addSubgraph: rejects parentId pointing at non-existent subgraph", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "child",
    parentId: "ghost-parent",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("ghost-parent"), true);
});

Deno.test("addSubgraph: rejects gates outside nodeIds", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const result = addSubgraph(g, [], {
    slug: "gated",
    nodeIds: ["A"],
    gates: ["B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("not a member"), true);
});

// ---------------------------------------------------------------------------
// subgraphOutcome
// ---------------------------------------------------------------------------

Deno.test("subgraphOutcome: ALL/FAIL_FAST — pending while any node not terminal", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
  ]);
  const sgResult = addSubgraph(g, [], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(subgraphOutcome(g, sgResult.value!), "pending");
});

Deno.test("subgraphOutcome: ALL — completed when every node DONE/MERGED/PR_CREATED", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.MERGED }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "completed");
});

Deno.test("subgraphOutcome: FAIL_FAST flips to failed on first FAILED node", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.FAILED }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "failed");
});

Deno.test("subgraphOutcome: CONTINUE — fails only when all nodes failed", () => {
  const partial = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.FAILED }),
  ]);
  const sgPartial = addSubgraph(partial, [], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.CONTINUE,
  }).value!;
  assertEquals(subgraphOutcome(partial, sgPartial), "completed");

  const allFail = makeGraph([
    makeNode({ id: "A", status: NodeStatus.FAILED }),
    makeNode({ id: "B", status: NodeStatus.FAILED }),
  ]);
  const sgAllFail = addSubgraph(allFail, [], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.CONTINUE,
  }).value!;
  assertEquals(subgraphOutcome(allFail, sgAllFail), "failed");
});

Deno.test("subgraphOutcome: ANY — completed when any node terminal", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.PENDING }),
    makeNode({ id: "B", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "core",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ANY,
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "completed");
});

Deno.test("subgraphOutcome: GATED — completed only when every gate is terminal", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.PENDING }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "core",
    nodeIds: ["A", "B", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    gates: ["G"],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "completed");
});

Deno.test("addSubgraph: hierarchy via parentId", () => {
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
  ]);
  const parent = addSubgraph(g, [], {
    slug: "epic",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    label: "Epic root",
  });
  assertEquals(parent.ok, true);
  const child = addSubgraph(g, [parent.value!], {
    slug: "task-b",
    parentId: "epic",
    nodeIds: ["B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(child.ok, true);
  assertEquals(child.value!.parentId, "epic");
  assertEquals(parent.value!.label, "Epic root");
});

// ---------------------------------------------------------------------------
// serializeSubgraphBrief
// ---------------------------------------------------------------------------

Deno.test("serializeSubgraphBrief: produces valid markdown for adjunct subgraph", () => {
  const g = makeGraph([
    makeNode({
      id: "impl",
      executor: Executor.ADJUNCT,
      label: "Refactor handler",
    }),
    makeNode({
      id: "vc",
      executor: Executor.ADJUNCT,
      type: NodeType.VERIFY_COMPILE,
      label: "Compile check",
    }),
  ], [
    { from: "impl", to: "vc", type: EdgeType.DEPENDS_ON },
  ]);
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T2, SubgraphStrategy.INDEPENDENT);
  const adjunctSg = sgs.find((s) => s.executor === Executor.ADJUNCT)!;
  adjunctSg.assignee = "Three of Five";

  const brief = serializeSubgraphBrief(g, adjunctSg);
  assertEquals(brief.includes("## Subgraph:"), true);
  assertEquals(brief.includes("Three of Five"), true);
  assertEquals(brief.includes("### Traversal Order"), true);
  assertEquals(brief.includes("[IMPLEMENTATION]"), true);
  assertEquals(brief.includes("[VERIFY_COMPILE]"), true);
});

// ---------------------------------------------------------------------------
// parallelNodesInWave
// ---------------------------------------------------------------------------

Deno.test("parallelNodesInWave: all independent nodes in one batch", () => {
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
    makeNode({ id: "C" }),
  ]);
  const wave: Wave = { id: 1, nodes: ["A", "B", "C"], hasMergeGate: false };
  const batches = parallelNodesInWave(g, wave);
  assertEquals(batches.length, 1);
  assertEquals(batches[0].length, 3);
});

Deno.test("parallelNodesInWave: STACKED nodes form sequential chain", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A" }),
      makeNode({ id: "B" }),
      makeNode({ id: "C" }),
    ],
    [{ from: "A", to: "B", type: EdgeType.STACKED }],
  );
  const wave: Wave = { id: 1, nodes: ["A", "B", "C"], hasMergeGate: false };
  const batches = parallelNodesInWave(g, wave);
  // C is independent, A→B is a chain
  assertEquals(batches.length, 2);
  const chainBatch = batches.find((b) => b.length === 2);
  const independentBatch = batches.find((b) => b.length === 1);
  assertEquals(chainBatch !== undefined, true);
  assertEquals(independentBatch !== undefined, true);
  assertEquals(chainBatch![0], "A");
  assertEquals(chainBatch![1], "B");
  assertEquals(independentBatch![0], "C");
});

Deno.test("parallelNodesInWave: empty wave returns empty", () => {
  const g = makeGraph([]);
  const wave: Wave = { id: 1, nodes: [], hasMergeGate: false };
  assertEquals(parallelNodesInWave(g, wave).length, 0);
});

// ---------------------------------------------------------------------------
// ELICIT_GATE tests
// ---------------------------------------------------------------------------

Deno.test("validate: ELICIT_GATE with ADJUNCT executor rejected", () => {
  const g = makeGraph([
    makeNode({
      id: "eg1",
      type: NodeType.ELICIT_GATE,
      executor: Executor.ADJUNCT,
      elicitPrompt: "Choose approach",
    }),
  ]);
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    'ELICIT_GATE node "eg1" must have executor LEAD, got ADJUNCT',
  );
});

Deno.test("validate: ELICIT_GATE without elicitPrompt rejected", () => {
  const g = makeGraph([
    makeNode({
      id: "eg1",
      type: NodeType.ELICIT_GATE,
      executor: Executor.LEAD,
      // no elicitPrompt
    }),
  ]);
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    'ELICIT_GATE node "eg1" is missing elicitPrompt',
  );
});

Deno.test("validate: valid ELICIT_GATE passes", () => {
  const g = makeGraph([
    makeNode({
      id: "eg1",
      type: NodeType.ELICIT_GATE,
      executor: Executor.LEAD,
      elicitPrompt: "Which database engine?",
    }),
  ]);
  const result = validate(g);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("computeSubgraphs: ELICIT_GATE assigned to lead subgraph", () => {
  const g = makeGraph(
    [
      makeNode({
        id: "eg1",
        type: NodeType.ELICIT_GATE,
        executor: Executor.LEAD,
        elicitPrompt: "Choose approach",
      }),
      makeNode({
        id: "impl1",
        type: NodeType.IMPLEMENTATION,
        executor: Executor.ADJUNCT,
      }),
    ],
    [{ from: "eg1", to: "impl1", type: EdgeType.DEPENDS_ON }],
  );
  const waves = computeWaves(g);
  const sgs = computeSubgraphs(g, waves, Tier.T2, SubgraphStrategy.INDEPENDENT);
  // Lead subgraph contains the elicit gate
  const leadSg = sgs.find((sg) => sg.id === "sg-lead");
  assertEquals(leadSg !== undefined, true);
  assertEquals(leadSg!.nodes.includes("eg1"), true);
  // Adjunct subgraph contains the implementation node
  const adjunctSg = sgs.find((sg) => sg.executor === Executor.ADJUNCT);
  assertEquals(adjunctSg !== undefined, true);
  assertEquals(adjunctSg!.nodes.includes("impl1"), true);
});

Deno.test("computeWaves: ELICIT_GATE with DEPENDS_ON creates wave boundary", () => {
  const g = makeGraph(
    [
      makeNode({ id: "recon1", type: NodeType.RECON, executor: Executor.LEAD }),
      makeNode({
        id: "eg1",
        type: NodeType.ELICIT_GATE,
        executor: Executor.LEAD,
        elicitPrompt: "Proceed with implementation?",
      }),
      makeNode({
        id: "impl1",
        type: NodeType.IMPLEMENTATION,
        executor: Executor.ADJUNCT,
      }),
    ],
    [
      { from: "recon1", to: "eg1", type: EdgeType.DEPENDS_ON },
      { from: "eg1", to: "impl1", type: EdgeType.DEPENDS_ON },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 3);
  assertEquals(waves[0].nodes, ["recon1"]);
  assertEquals(waves[1].nodes, ["eg1"]);
  assertEquals(waves[2].nodes, ["impl1"]);
  // Wave 0 and 1 should have hasMergeGate since DEPENDS_ON edges cross into later waves
  assertEquals(waves[0].hasMergeGate, true);
  assertEquals(waves[1].hasMergeGate, true);
});

// ---------------------------------------------------------------------------
// unsatisfiedDependencies
// ---------------------------------------------------------------------------

Deno.test("unsatisfiedDependencies: empty for node with no incoming edges", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  assertEquals(unsatisfiedDependencies(g, "A"), []);
});

Deno.test("unsatisfiedDependencies: empty when DEPENDS_ON sources are DONE/MERGED", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.DONE }),
      makeNode({ id: "B", status: NodeStatus.MERGED }),
      makeNode({ id: "C", status: NodeStatus.PENDING }),
    ],
    [
      { from: "A", to: "C", type: EdgeType.DEPENDS_ON },
      { from: "B", to: "C", type: EdgeType.DEPENDS_ON },
    ],
  );
  assertEquals(unsatisfiedDependencies(g, "C"), []);
});

Deno.test("unsatisfiedDependencies: unsatisfied when DEPENDS_ON source is PENDING", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.PENDING }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const result = unsatisfiedDependencies(g, "B");
  assertEquals(result.length, 1);
  assertEquals(result[0].edge.from, "A");
  assertEquals(result[0].reason.includes("PENDING"), true);
});

Deno.test("unsatisfiedDependencies: unsatisfied when DEPENDS_ON source is ACTIVE", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.ACTIVE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const result = unsatisfiedDependencies(g, "B");
  assertEquals(result.length, 1);
});

Deno.test("unsatisfiedDependencies: unsatisfied when MERGE_GATE source is DONE (not MERGED)", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.DONE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.MERGE_GATE }],
  );
  const result = unsatisfiedDependencies(g, "B");
  assertEquals(result.length, 1);
  assertEquals(result[0].reason.includes("requires MERGED"), true);
});

Deno.test("unsatisfiedDependencies: unsatisfied when MERGE_GATE source is MERGED but lacks prUrl", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.MERGE_GATE }],
  );
  const result = unsatisfiedDependencies(g, "B");
  assertEquals(result.length, 1);
  assertEquals(result[0].reason.includes("lacks prUrl"), true);
});

Deno.test("unsatisfiedDependencies: empty when MERGE_GATE source is MERGED with prUrl", () => {
  const g = makeGraph(
    [
      makeNode({
        id: "A",
        status: NodeStatus.MERGED,
        prUrl: "https://github.com/o/r/pull/1",
      }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.MERGE_GATE }],
  );
  assertEquals(unsatisfiedDependencies(g, "B"), []);
});

Deno.test("unsatisfiedDependencies: unsatisfied when STACKED source is PENDING", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.PENDING }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.STACKED }],
  );
  const result = unsatisfiedDependencies(g, "B");
  assertEquals(result.length, 1);
  assertEquals(result[0].reason.includes("PR_CREATED or MERGED"), true);
});

Deno.test("unsatisfiedDependencies: empty when STACKED source is PR_CREATED", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.PR_CREATED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.STACKED }],
  );
  assertEquals(unsatisfiedDependencies(g, "B"), []);
});

Deno.test("unsatisfiedDependencies: mixed edges — returns only unsatisfied subset", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.DONE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
      makeNode({ id: "C", status: NodeStatus.PENDING }),
    ],
    [
      { from: "A", to: "C", type: EdgeType.DEPENDS_ON }, // satisfied
      { from: "B", to: "C", type: EdgeType.DEPENDS_ON }, // unsatisfied
    ],
  );
  const result = unsatisfiedDependencies(g, "C");
  assertEquals(result.length, 1);
  assertEquals(result[0].edge.from, "B");
});

// ---------------------------------------------------------------------------
// validate: FAILED source satisfiability
// ---------------------------------------------------------------------------

Deno.test("validate: detects FAILED source node as unsatisfiable", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.FAILED }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((e) =>
      e.includes("Unsatisfiable") && e.includes("FAILED")
    ),
    true,
  );
});

Deno.test("validate: passes when no FAILED sources exist", () => {
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.DONE }),
      makeNode({ id: "B", status: NodeStatus.PENDING }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const result = validate(g);
  assertEquals(result.valid, true);
});

// ---------------------------------------------------------------------------
// Idempotent addSubgraph re-add (P0)
// ---------------------------------------------------------------------------

Deno.test("addSubgraph idempotency: same slug same spec returns existing subgraph", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const first = addSubgraph(g, [], {
    slug: "idm-test",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
  });
  assertEquals(first.ok, true);
  // Re-add with identical spec — idempotent no-op.
  const second = addSubgraph(g, [first.value!], {
    slug: "idm-test",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
  });
  assertEquals(second.ok, true);
  // Must return the same object identity (the existing subgraph).
  assertEquals(second.value!.id, "idm-test");
  assertEquals(second.value!.nodes.sort(), ["A", "B"].sort());
});

Deno.test("addSubgraph idempotency: same slug different nodes returns error", () => {
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
    makeNode({ id: "C" }),
  ]);
  const first = addSubgraph(g, [], {
    slug: "conflict",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(first.ok, true);
  const second = addSubgraph(g, [first.value!], {
    slug: "conflict",
    nodeIds: ["A", "C"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(second.ok, false);
  assertEquals(second.error?.includes("already exists"), true);
});

Deno.test("addSubgraph idempotency: same slug different failure policy returns error", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "G" })]);
  // First add: BEST_EFFORT with gate G.
  const first = addSubgraph(g, [], {
    slug: "pol-test",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: ["G"],
  });
  assertEquals(first.ok, true);
  // Re-add same slug but CONTINUE policy — must reject.
  const second = addSubgraph(g, [first.value!], {
    slug: "pol-test",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.CONTINUE,
    gates: ["G"],
  });
  assertEquals(second.ok, false);
  assertEquals(second.error?.includes("already exists"), true);
});

Deno.test("addSubgraph idempotency: same slug different gates set returns error", () => {
  // Regression for cross-layer idempotency divergence: the server-side check
  // previously omitted `gates`, so a re-add with a different gate composition
  // could be reported as idempotent. The graph layer is the single authority
  // and must reject differing gate sets.
  const g = makeGraph([
    makeNode({ id: "A" }),
    makeNode({ id: "B" }),
    makeNode({ id: "C" }),
  ]);
  const first = addSubgraph(g, [], {
    slug: "gates-test",
    nodeIds: ["A", "B", "C"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    gates: ["A"],
  });
  assertEquals(first.ok, true);
  const second = addSubgraph(g, [first.value!], {
    slug: "gates-test",
    nodeIds: ["A", "B", "C"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    gates: ["B"],
  });
  assertEquals(second.ok, false);
  assertEquals(second.error?.includes("already exists"), true);
});

Deno.test("addSubgraph idempotency: same slug different parentId returns error", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const parent = addSubgraph(g, [], {
    slug: "parent-sg",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(parent.ok, true);
  const first = addSubgraph(g, [parent.value!], {
    slug: "child-sg",
    nodeIds: ["B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    parentId: "parent-sg",
  });
  assertEquals(first.ok, true);
  const second = addSubgraph(g, [parent.value!, first.value!], {
    slug: "child-sg",
    nodeIds: ["B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    // parentId omitted — no longer matches existing.
  });
  assertEquals(second.ok, false);
  assertEquals(second.error?.includes("already exists"), true);
});

// ---------------------------------------------------------------------------
// M2: BEST_EFFORT degeneracy rejection (P0)
// ---------------------------------------------------------------------------

Deno.test("addSubgraph: BEST_EFFORT with no gates is rejected (M2)", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const result = addSubgraph(g, [], {
    slug: "be-no-gates",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("BEST_EFFORT"), true);
  assertEquals(result.error?.includes("gate"), true);
});

Deno.test("addSubgraph: BEST_EFFORT with empty gates array is rejected (M2)", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "be-empty-gates",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: [],
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("BEST_EFFORT"), true);
});

Deno.test("addSubgraph: BEST_EFFORT with at least one gate is accepted (M2 boundary)", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "G" })]);
  const result = addSubgraph(g, [], {
    slug: "be-with-gate",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: ["G"],
  });
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// M3: ANY + FAIL_FAST ordering contract lock (P0)
// ---------------------------------------------------------------------------

Deno.test("subgraphOutcome: ANY + FAIL_FAST — failure short-circuits before completion check (M3)", () => {
  // Contract: [DONE, FAILED] with ANY+FAIL_FAST must yield "failed".
  // FAIL_FAST trips first; the ANY completion check never runs.
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.FAILED }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "any-ff",
    nodeIds: ["A", "B"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ANY,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "failed");
});

// ---------------------------------------------------------------------------
// SubgraphGate polymorphism (P0)
// ---------------------------------------------------------------------------

Deno.test("addSubgraph: external gate with non-empty source and externalId is accepted", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "G" })]);
  const result = addSubgraph(g, [], {
    slug: "ext-gate",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: [
      "G",
      { kind: "external", source: "jira", externalId: "PROJ-42" },
    ],
  });
  assertEquals(result.ok, true);
});

Deno.test("addSubgraph: external gate missing source is rejected", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "bad-gate",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: [{ kind: "external", source: "", externalId: "PROJ-42" }],
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("source"), true);
});

Deno.test("addSubgraph: external gate missing externalId is rejected", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "bad-gate2",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: [{ kind: "external", source: "jira", externalId: "" }],
  });
  assertEquals(result.ok, false);
  assertEquals(result.error?.includes("externalId"), true);
});

Deno.test("subgraphOutcome: GATED with external gate — always unresolved, never completes", () => {
  // A GATED subgraph with an external gate must never reach "completed"
  // because external gates are always unresolved until UNM-1b7.7.
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  // Manually construct subgraph (gates field includes external gate).
  const sg = addSubgraph(g, [], {
    slug: "ext-gated",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.CONTINUE,
    gates: [
      "G",
      { kind: "external", source: "jira", externalId: "PROJ-1" },
    ],
  }).value!;
  // Both node gate and all local nodes done — but external gate blocks completion.
  const outcome = subgraphOutcome(g, sg);
  assertEquals(outcome !== "completed", true);
});

Deno.test("subgraphOutcome: BEST_EFFORT with external gate — trips failure", () => {
  // External gates are always unresolved; BEST_EFFORT treats unresolved external
  // gates as failures and immediately trips.
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "be-ext",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: [
      "G",
      { kind: "external", source: "github-pr", externalId: "99" },
    ],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "failed");
});

Deno.test("subgraphOutcome: GATED with mixed node+external — blocked by external gate", () => {
  // Node gate is satisfied; external gate is not — subgraph must not complete.
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "mixed-gates",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.CONTINUE,
    gates: [
      "G",
      { kind: "external", source: "linear", externalId: "LIN-7" },
    ],
  }).value!;
  const outcome = subgraphOutcome(g, sg);
  // Cannot complete because external gate is unresolved.
  assertEquals(outcome === "completed", false);
});

// ---------------------------------------------------------------------------
// 9-cell matrix: uncovered cells (P1)
// ---------------------------------------------------------------------------

Deno.test("subgraphOutcome: BEST_EFFORT + ANY — ANY completion with failed non-gate", () => {
  // BEST_EFFORT + ANY: any terminal-OK node satisfies ANY. Non-gate FAILED
  // nodes are tolerated. Failure policy is checked first but BEST_EFFORT only
  // trips on gate failure — no gate is FAILED here — so completion wins.
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "B", status: NodeStatus.FAILED }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "be-any",
    nodeIds: ["A", "B", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ANY,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: ["G"],
  }).value!;
  // G is ok (gate not failed), A is ok → ANY satisfied → "completed".
  assertEquals(subgraphOutcome(g, sg), "completed");
});

Deno.test("subgraphOutcome: BEST_EFFORT + ALL with gate failure — trips failed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "G", status: NodeStatus.FAILED }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "be-all-gf",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: ["G"],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "failed");
});

Deno.test("subgraphOutcome: BEST_EFFORT + ALL with non-gate failure — completes via tolerated failure", () => {
  // G (gate) is DONE. A (non-gate) is FAILED — tolerated by BEST_EFFORT.
  // ALL: all members settled (A tolerated, G ok) → "completed".
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.FAILED }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "be-all-ngf",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.BEST_EFFORT,
    gates: ["G"],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "completed");
});

Deno.test("subgraphOutcome: GATED + CONTINUE — gates must clear; non-gate FAILED tolerated", () => {
  // G (gate) is DONE. A (non-gate) is FAILED — CONTINUE tolerates it.
  // GATED completion: every gate is terminal-ok → "completed".
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.FAILED }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "gated-cont",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.CONTINUE,
    gates: ["G"],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "completed");
});

Deno.test("subgraphOutcome: GATED + FAIL_FAST with gate failure — fails", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.DONE }),
    makeNode({ id: "G", status: NodeStatus.FAILED }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "gated-ff-gf",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    gates: ["G"],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "failed");
});

Deno.test("subgraphOutcome: GATED + FAIL_FAST with non-gate failure — fails (FAIL_FAST trips before GATED checks)", () => {
  // FAIL_FAST is checked first — even though the gate G is done,
  // A (non-gate) is FAILED → FAIL_FAST trips immediately.
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.FAILED }),
    makeNode({ id: "G", status: NodeStatus.DONE }),
  ]);
  const sg = addSubgraph(g, [], {
    slug: "gated-ff-ngf",
    nodeIds: ["A", "G"],
    executor: Executor.LEAD,
    tier: Tier.T1,
    completionPolicy: SubgraphCompletionPolicy.GATED,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    gates: ["G"],
  }).value!;
  assertEquals(subgraphOutcome(g, sg), "failed");
});

// ---------------------------------------------------------------------------
// Slug regex boundary tests (P1)
// ---------------------------------------------------------------------------

Deno.test("addSubgraph: slug '\"a\"' (1-char) is accepted", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "a",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, true, result.error);
});

Deno.test("addSubgraph: 41-char slug is accepted", () => {
  // 41 chars: 'a' + 39 lower-alphanum + 'z' = 41 total
  const slug = "a" + "b".repeat(39) + "z";
  assertEquals(slug.length, 41);
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug,
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, true, result.error);
});

Deno.test("addSubgraph: 42-char slug is rejected", () => {
  const slug = "a" + "b".repeat(40) + "z";
  assertEquals(slug.length, 42);
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug,
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
});

Deno.test("addSubgraph: underscore in slug is rejected", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "foo_bar",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
});

Deno.test("addSubgraph: 'a-b' slug (hyphen between alphanum) is accepted", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "a-b",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, true, result.error);
});

Deno.test("addSubgraph: 'a--b' slug (double hyphen) is accepted", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "a--b",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, true, result.error);
});

Deno.test("addSubgraph: trailing hyphen in slug is rejected", () => {
  const g = makeGraph([makeNode({ id: "A" })]);
  const result = addSubgraph(g, [], {
    slug: "abc-",
    nodeIds: ["A"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// Stability: derived ID changes when own member set changes (P1 — M5 caveat)
// ---------------------------------------------------------------------------

Deno.test("computeSubgraphs: derived ID changes when own member set changes (M5 caveat)", () => {
  // Subgraph {A,B} has a stable hash. When B leaves the component
  // (now {A} only), the hash must change — the member set changed.
  const g1 = makeGraph(
    [
      makeNode({ id: "A", executor: Executor.ADJUNCT }),
      makeNode({ id: "B", executor: Executor.ADJUNCT }),
    ],
    [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  );
  const sgs1 = computeSubgraphs(g1, [], Tier.T2, SubgraphStrategy.INDEPENDENT);
  const ab =
    sgs1.find((s) => s.nodes.includes("A") && s.nodes.includes("B"))!.id;

  // Now only node A remains. Hash input changed — ID must differ.
  const g2 = makeGraph([
    makeNode({ id: "A", executor: Executor.ADJUNCT }),
  ]);
  const sgs2 = computeSubgraphs(g2, [], Tier.T2, SubgraphStrategy.INDEPENDENT);
  const aOnly = sgs2.find((s) => s.nodes.includes("A"))!.id;

  assertEquals(
    ab !== aOnly,
    true,
    "subgraph ID must change when member set changes",
  );
  assertEquals(ab.startsWith("auto-"), true);
  assertEquals(aOnly.startsWith("auto-"), true);
});

// ---------------------------------------------------------------------------
// canDispatch — capability matching
// ---------------------------------------------------------------------------

Deno.test("canDispatch: accepts node with no requirements (undefined)", () => {
  const caps: Capabilities = {
    repos: ["repo-a"],
    tools: ["bash"],
    canWrite: true,
  };
  const result = canDispatch(caps, undefined);
  assertEquals(result.ok, true);
});

Deno.test("canDispatch: rejects when required repo is absent from capabilities", () => {
  const caps: Capabilities = { repos: ["repo-a"] };
  const result = canDispatch(caps, { repos: ["repo-b"] });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.missing.includes("repo:repo-b"), true);
  }
});

Deno.test("canDispatch: accepts when capabilities advertise wildcard repo '*'", () => {
  const caps: Capabilities = { repos: ["*"] };
  const result = canDispatch(caps, { repos: ["repo-any", "repo-other"] });
  assertEquals(result.ok, true);
});

Deno.test("canDispatch: rejects when required tool is absent from capabilities", () => {
  const caps: Capabilities = { tools: ["edit"] };
  const result = canDispatch(caps, { tools: ["bash", "web"] });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.missing.includes("tool:bash"), true);
    assertEquals(result.missing.includes("tool:web"), true);
  }
});

Deno.test("canDispatch: enforces canWrite strictly — true required but capability false", () => {
  const caps: Capabilities = { canWrite: false };
  const result = canDispatch(caps, { canWrite: true });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.missing.includes("canWrite"), true);
  }
});

Deno.test("canDispatch: enforces humanPresent strictly — true required but capability absent", () => {
  const caps: Capabilities = {};
  const result = canDispatch(caps, { humanPresent: true });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.missing.includes("humanPresent"), true);
  }
});

Deno.test("validateDispatch: returns missing list in error message when requirements unmet", () => {
  const node = makeNode({
    id: "n1",
    requirements: { repos: ["repo-secret"], tools: ["bash"] },
  });
  const graph = makeGraph([node]);
  const caps: Capabilities = { repos: ["repo-public"], tools: [] };
  const result = validateDispatch(graph, "n1", caps);
  assertEquals(result.ok, false);
  if (!result.ok && result.error) {
    assertEquals(result.error.includes("repo:repo-secret"), true);
    assertEquals(result.error.includes("tool:bash"), true);
  }
});

Deno.test("validateDispatch: returns ok:true when all requirements are satisfied", () => {
  const node = makeNode({
    id: "n2",
    requirements: { repos: ["repo-a"], canWrite: true },
  });
  const graph = makeGraph([node]);
  const caps: Capabilities = { repos: ["*"], canWrite: true };
  const result = validateDispatch(graph, "n2", caps);
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// currentFrontier (UNM-1b7.5)
// ---------------------------------------------------------------------------

Deno.test("currentFrontier: empty graph returns []", () => {
  const g = makeGraph([]);
  const result = currentFrontier(g, []);
  assertEquals(result, []);
});

Deno.test("currentFrontier: returns only PENDING+READY nodes — excludes ACTIVE, DONE, BLOCKED, FAILED", () => {
  const g = makeGraph([
    makeNode({
      id: "pending",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "active",
      status: NodeStatus.ACTIVE,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "done",
      status: NodeStatus.DONE,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "failed",
      status: NodeStatus.FAILED,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "blocked_rs",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.BLOCKED,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["pending", "active", "done", "failed", "blocked_rs"],
    hasMergeGate: false,
  }];
  const result = currentFrontier(g, waves);
  assertEquals(result.length, 1);
  assertEquals(result[0].nodeId, "pending");
  assertEquals(result[0].wave, 1);
});

Deno.test("currentFrontier: returns nodes from multiple waves when deps are clear", () => {
  // wave 1: node A (PENDING+READY), wave 2: node B (PENDING+READY — deps satisfied)
  const g = makeGraph([
    makeNode({
      id: "A",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "B",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [
    { id: 1, nodes: ["A"], hasMergeGate: false },
    { id: 2, nodes: ["B"], hasMergeGate: false },
  ];
  const result = currentFrontier(g, waves);
  assertEquals(result.length, 2);
  assertEquals(result[0], { nodeId: "A", wave: 1 });
  assertEquals(result[1], { nodeId: "B", wave: 2 });
});

Deno.test("currentFrontier: wave-3 node whose deps are satisfied appears even when wave-1 is incomplete", () => {
  // Locks the contract: frontier crosses wave boundaries.
  // Wave 1: nodeA is still PENDING (not done). Wave 3: nodeC is PENDING+READY (deps on nodeB which is DONE).
  const g = makeGraph(
    [
      makeNode({
        id: "A",
        status: NodeStatus.PENDING,
        readinessStatus: ReadinessStatus.READY,
      }),
      makeNode({
        id: "B",
        status: NodeStatus.DONE,
        readinessStatus: ReadinessStatus.READY,
      }),
      makeNode({
        id: "C",
        status: NodeStatus.PENDING,
        readinessStatus: ReadinessStatus.READY,
      }),
    ],
    [{ from: "B", to: "C", type: EdgeType.DEPENDS_ON }],
  );
  const waves: Wave[] = [
    { id: 1, nodes: ["A"], hasMergeGate: false },
    { id: 2, nodes: ["B"], hasMergeGate: true },
    { id: 3, nodes: ["C"], hasMergeGate: false },
  ];
  const result = currentFrontier(g, waves);
  // Both A (wave 1) and C (wave 3) are PENDING+READY — both appear
  assertEquals(result.length, 2);
  assertEquals(result[0], { nodeId: "A", wave: 1 });
  assertEquals(result[1], { nodeId: "C", wave: 3 });
});

Deno.test("currentFrontier: deterministic order across repeated calls", () => {
  const g = makeGraph([
    makeNode({
      id: "Z",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "A",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "M",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["Z", "A", "M"],
    hasMergeGate: false,
  }];
  const r1 = currentFrontier(g, waves);
  const r2 = currentFrontier(g, waves);
  // Both calls must return the same order
  assertEquals(r1, r2);
  // Within same wave, nodes sorted by nodeId asc
  assertEquals(r1.map((e) => e.nodeId), ["A", "M", "Z"]);
});

// ---------------------------------------------------------------------------
// nextFrontierBatch (UNM-1b7.5)
// ---------------------------------------------------------------------------

Deno.test("nextFrontierBatch: groups by wave and returns all eligible waves at once", () => {
  // Wave 1: A (PENDING+READY), Wave 2: B (PENDING+READY), Wave 3: C (PENDING+BLOCKED)
  const g = makeGraph([
    makeNode({
      id: "A",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "B",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "C",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.BLOCKED,
    }),
  ]);
  const waves: Wave[] = [
    { id: 1, nodes: ["A"], hasMergeGate: false },
    { id: 2, nodes: ["B"], hasMergeGate: false },
    { id: 3, nodes: ["C"], hasMergeGate: false },
  ];
  const result = nextFrontierBatch(g, waves, null);
  // Only waves 1 and 2 have eligible nodes
  assertEquals(result.length, 2);
  assertEquals(result[0], { wave: 1, nodeIds: ["A"] });
  assertEquals(result[1], { wave: 2, nodeIds: ["B"] });
});

Deno.test("nextFrontierBatch: returns [] when no PENDING+READY nodes exist", () => {
  const g = makeGraph([
    makeNode({
      id: "A",
      status: NodeStatus.ACTIVE,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "B",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.BLOCKED,
    }),
  ]);
  const waves: Wave[] = [{ id: 1, nodes: ["A", "B"], hasMergeGate: false }];
  const result = nextFrontierBatch(g, waves, 1);
  assertEquals(result, []);
});

// ---------------------------------------------------------------------------
// externallyBlocked filter on currentFrontier / nextFrontierBatch (MAJOR #2)
// ---------------------------------------------------------------------------

Deno.test("currentFrontier: externallyBlocked nodes are excluded even when PENDING+READY", () => {
  const g = makeGraph([
    makeNode({
      id: "blocked-ext",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode({
      id: "clear",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: false,
    }),
    makeNode({
      id: "no-flag",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["blocked-ext", "clear", "no-flag"],
    hasMergeGate: false,
  }];
  const result = currentFrontier(g, waves);

  const ids = result.map((e) => e.nodeId).sort();
  assertEquals(
    ids.includes("blocked-ext"),
    false,
    "externallyBlocked node must not appear",
  );
  assertEquals(ids.includes("clear"), true, "clear node must appear");
  assertEquals(ids.includes("no-flag"), true, "unflagged node must appear");
});

Deno.test("currentFrontier: multiple externallyBlocked nodes all excluded, unflagged nodes all present", () => {
  const g = makeGraph([
    makeNode({
      id: "ext1",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode({
      id: "ext2",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode({
      id: "ok1",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
    makeNode({
      id: "ok2",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["ext1", "ext2", "ok1", "ok2"],
    hasMergeGate: false,
  }];
  const result = currentFrontier(g, waves);

  assertEquals(result.length, 2);
  const ids = result.map((e) => e.nodeId).sort();
  assertEquals(ids, ["ok1", "ok2"]);
});

Deno.test("nextFrontierBatch: externallyBlocked nodes excluded from batches", () => {
  const g = makeGraph([
    makeNode({
      id: "ext",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode({
      id: "free",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["ext", "free"],
    hasMergeGate: false,
  }];
  const result = nextFrontierBatch(g, waves, null);

  assertEquals(result.length, 1);
  assertEquals(result[0].nodeIds, ["free"]);
  assertEquals(result[0].nodeIds.includes("ext"), false);
});

Deno.test("nextFrontierBatch: all externallyBlocked nodes in a wave → wave omitted from batch", () => {
  const g = makeGraph([
    makeNode({
      id: "ext1",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode({
      id: "ext2",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode({
      id: "free",
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [
    { id: 1, nodes: ["ext1", "ext2"], hasMergeGate: false },
    { id: 2, nodes: ["free"], hasMergeGate: false },
  ];
  const result = nextFrontierBatch(g, waves, null);

  // Wave 1 is entirely blocked externally → omitted. Wave 2 has the free node.
  assertEquals(result.length, 1);
  assertEquals(result[0].wave, 2);
  assertEquals(result[0].nodeIds, ["free"]);
});
