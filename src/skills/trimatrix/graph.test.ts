/**
 * Tests for the trimatrix graph engine (graph.ts).
 *
 * Covers: validate, computeWaves, nextWave, completeNode, failNode,
 * clearGate, waveStatus, activateNodes, addNode, addEdge,
 * computeWavesFromRefinement.
 */

import { assertEquals } from "@std/assert";
import {
  activateNodes,
  addEdge,
  addNode,
  clearGate,
  completeNode,
  computeWaves,
  computeWavesFromRefinement,
  failNode,
  nextWave,
  validate,
  waveStatus,
} from "./graph.ts";
import { EdgeType, NodeStatus, NodeType } from "./types.ts";
import type { Graph, Node, Wave } from "./types.ts";

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
  // A merged → B's MERGE_GATE dependency is satisfied.
  const g = makeGraph(
    [
      makeNode({ id: "A", status: NodeStatus.MERGED }),
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

Deno.test("completeNode: sets PR_CREATED when PR info supplied", () => {
  const original = makeGraph([makeNode({ id: "A", status: NodeStatus.ACTIVE })]);
  const updated = completeNode(original, "A", {
    url: "https://gh.example/pr/1",
    number: 1,
  });
  assertEquals(updated.nodes["A"].status, NodeStatus.PR_CREATED);
  assertEquals(updated.nodes["A"].prUrl, "https://gh.example/pr/1");
  assertEquals(updated.nodes["A"].prNumber, 1);
  // Original is not mutated
  assertEquals(original.nodes["A"].status, NodeStatus.ACTIVE);
});

Deno.test("completeNode: with repo, no PR → MERGED", () => {
  const g = makeGraph([makeNode({ id: "A", status: NodeStatus.ACTIVE, repo: "repo-a" })]);
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

Deno.test("completeNode: repo-less with PR → PR_CREATED", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: NodeStatus.ACTIVE }),
  ]);
  delete (g.nodes["A"] as Partial<Node>).repo;
  const updated = completeNode(g, "A", { url: "https://gh.example/pr/2", number: 2 });
  assertEquals(updated.nodes["A"].status, NodeStatus.PR_CREATED);
});

Deno.test("failNode: sets FAILED status and failureReason", () => {
  const original = makeGraph([makeNode({ id: "A", status: NodeStatus.ACTIVE })]);
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
      makeNode({ id: "C", repo: "repo-x", status: NodeStatus.PENDING, stackedOn: "B" }),
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
