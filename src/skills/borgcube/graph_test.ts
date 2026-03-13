/**
 * Tests for the borgcube graph engine (graph.ts).
 *
 * Covers: validate, computeWaves, nextWave, completeNode, failNode,
 * clearGate, and waveStatus.
 */

import { assertEquals } from "@std/assert";
import {
  clearGate,
  completeNode,
  computeWaves,
  failNode,
  nextWave,
  validate,
  waveStatus,
} from "./graph.ts";
import type { Graph, Node, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: "n",
    repo: "repo-a",
    type: "implementation",
    label: "Node",
    worktreeBranch: "borgcube/n",
    status: "pending",
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

Deno.test("validate: valid simple chain A→B→C (merge_gate)", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: "merge_gate" },
      { from: "B", to: "C", type: "merge_gate" },
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
      { from: "A", to: "C", type: "merge_gate" },
      { from: "B", to: "C", type: "merge_gate" },
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
      { from: "A", to: "B", type: "merge_gate" },
      { from: "B", to: "C", type: "merge_gate" },
      { from: "C", to: "A", type: "merge_gate" },
    ],
  );
  const result = validate(g);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length > 0, true);
});

Deno.test("validate: self-reference A→A", () => {
  const g = makeGraph(
    [makeNode({ id: "A" })],
    [{ from: "A", to: "A", type: "merge_gate" }],
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
    [{ from: "A", to: "MISSING", type: "merge_gate" }],
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

Deno.test("computeWaves: linear chain A→B→C (merge_gate) — 3 waves", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: "merge_gate" },
      { from: "B", to: "C", type: "merge_gate" },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 3);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes, ["B"]);
  assertEquals(waves[2].nodes, ["C"]);
  // Waves 0 and 1 each have outgoing merge_gate edges
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

Deno.test("computeWaves: fan-out after gate — wave 0:[A], wave 1:[B,C]", () => {
  const g = makeGraph(
    [makeNode({ id: "A" }), makeNode({ id: "B" }), makeNode({ id: "C" })],
    [
      { from: "A", to: "B", type: "merge_gate" },
      { from: "A", to: "C", type: "merge_gate" },
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
    [{ from: "A", to: "B", type: "stacked" }],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 1);
  assertEquals(waves[0].nodes.sort(), ["A", "B"]);
  assertEquals(waves[0].hasMergeGate, false);
});

Deno.test("computeWaves: mixed stacked and merge_gate", () => {
  // A and B are stacked (same wave). C gates on A (merge_gate → next wave).
  const g = makeGraph(
    [
      makeNode({ id: "A", repo: "repo-x" }),
      makeNode({ id: "B", repo: "repo-x", stackedOn: "A" }),
      makeNode({ id: "C", repo: "repo-y" }),
    ],
    [
      { from: "A", to: "B", type: "stacked" },
      { from: "A", to: "C", type: "merge_gate" },
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
      { from: "A", to: "B", type: "merge_gate" },
      { from: "A", to: "C", type: "merge_gate" },
      { from: "B", to: "D", type: "merge_gate" },
      { from: "C", to: "D", type: "merge_gate" },
    ],
  );
  const waves = computeWaves(g);
  assertEquals(waves.length, 3);
  assertEquals(waves[0].nodes, ["A"]);
  assertEquals(waves[1].nodes.sort(), ["B", "C"]);
  assertEquals(waves[2].nodes, ["D"]);
});

// ---------------------------------------------------------------------------
// nextWave
// ---------------------------------------------------------------------------

Deno.test("nextWave: first wave (currentWaveId null → wave 0)", () => {
  const g = makeGraph([makeNode({ id: "A" }), makeNode({ id: "B" })]);
  const waves = computeWaves(g);
  const next = nextWave(g, waves, null);
  assertEquals(next?.id, 0);
});

Deno.test("nextWave: gate not cleared → returns null", () => {
  // A must be merged before B can start (merge_gate).
  // A is only pr_created, not merged → gate not satisfied.
  const g = makeGraph(
    [
      makeNode({ id: "A", status: "pr_created" }),
      makeNode({ id: "B", status: "pending" }),
    ],
    [{ from: "A", to: "B", type: "merge_gate" }],
  );
  const waves = computeWaves(g);
  // currentWaveId = 0 (wave 0 is active)
  const next = nextWave(g, waves, 0);
  assertEquals(next, null);
});

Deno.test("nextWave: gate cleared (A merged) → returns wave 1", () => {
  // A merged → B's merge_gate dependency is satisfied.
  const g = makeGraph(
    [
      makeNode({ id: "A", status: "merged" }),
      makeNode({ id: "B", status: "pending" }),
    ],
    [{ from: "A", to: "B", type: "merge_gate" }],
  );
  const waves = computeWaves(g);
  const next = nextWave(g, waves, 0);
  assertEquals(next?.id, 1);
  assertEquals(next?.nodes, ["B"]);
});

Deno.test("nextWave: all waves done → returns null", () => {
  const g = makeGraph([makeNode({ id: "A", status: "merged" })]);
  const waves = computeWaves(g);
  // currentWaveId = 0, wave 0 is the last wave
  const next = nextWave(g, waves, 0);
  assertEquals(next, null);
});

// ---------------------------------------------------------------------------
// completeNode, failNode, clearGate — immutability checks
// ---------------------------------------------------------------------------

Deno.test("completeNode: sets pr_created when PR info supplied", () => {
  const original = makeGraph([makeNode({ id: "A", status: "active" })]);
  const updated = completeNode(original, "A", {
    url: "https://gh.example/pr/1",
    number: 1,
  });
  assertEquals(updated.nodes["A"].status, "pr_created");
  assertEquals(updated.nodes["A"].prUrl, "https://gh.example/pr/1");
  assertEquals(updated.nodes["A"].prNumber, 1);
  // Original is not mutated
  assertEquals(original.nodes["A"].status, "active");
});

Deno.test("completeNode: sets merged when no PR info supplied", () => {
  const g = makeGraph([makeNode({ id: "A", status: "active" })]);
  const updated = completeNode(g, "A");
  assertEquals(updated.nodes["A"].status, "merged");
});

Deno.test("failNode: sets failed status and failureReason", () => {
  const original = makeGraph([makeNode({ id: "A", status: "active" })]);
  const updated = failNode(original, "A", "build error");
  assertEquals(updated.nodes["A"].status, "failed");
  assertEquals(updated.nodes["A"].failureReason, "build error");
  // Original is not mutated
  assertEquals(original.nodes["A"].status, "active");
});

Deno.test("clearGate: sets active status and clears failureReason", () => {
  const original = makeGraph([
    makeNode({ id: "A", status: "blocked", failureReason: "gate" }),
  ]);
  const updated = clearGate(original, "A");
  assertEquals(updated.nodes["A"].status, "active");
  assertEquals(updated.nodes["A"].failureReason, undefined);
  // Original is not mutated
  assertEquals(original.nodes["A"].status, "blocked");
});

// ---------------------------------------------------------------------------
// waveStatus
// ---------------------------------------------------------------------------

function makeWave(id: number, nodes: string[]): Wave {
  return { id, nodes, hasMergeGate: false };
}

Deno.test("waveStatus: all nodes merged → completed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: "merged" }),
    makeNode({ id: "B", status: "merged" }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "completed");
});

Deno.test("waveStatus: one merged, one failed → partial_failure", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: "merged" }),
    makeNode({ id: "B", status: "failed" }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "partial_failure");
});

Deno.test("waveStatus: all nodes failed → failed", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: "failed" }),
    makeNode({ id: "B", status: "blocked" }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "failed");
});

Deno.test("waveStatus: at least one active, none failed → active", () => {
  const g = makeGraph([
    makeNode({ id: "A", status: "active" }),
    makeNode({ id: "B", status: "pending" }),
  ]);
  const wave = makeWave(0, ["A", "B"]);
  assertEquals(waveStatus(g, wave), "active");
});
