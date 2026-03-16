/**
 * State machine tests for borgcube execution lifecycle.
 *
 * Coverage:
 * - canTransition: valid and invalid transitions for each state
 * - transition: happy path, failure, retry, gate halt, final wave, partial failure
 * - serialize/deserialize: round trip, version mismatch, version field in JSON
 * - helpers: currentWave, failedNodes, pendingGates
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  canTransition,
  createCheckpoint,
  currentWave,
  deserialize,
  failedNodes,
  pendingGates,
  serialize,
  transition,
} from "./state.ts";
import type { Checkpoint, Graph, Node, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    repo: "test-repo",
    type: "implementation",
    label: `Node ${id}`,
    worktreeBranch: `borgcube/${id}`,
    status: "pending",
    ...overrides,
  };
}

function makeGraph(nodes: Node[], edges: Graph["edges"] = []): Graph {
  const nodeMap: Record<string, Node> = {};
  for (const n of nodes) {
    nodeMap[n.id] = n;
  }
  return { nodes: nodeMap, edges };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  const graph = makeGraph([makeNode("n1")]);
  const base: Checkpoint = {
    version: "1.0.0",
    machineState: "initializing",
    graph,
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// canTransition tests
// ---------------------------------------------------------------------------

// Test 1: plan_approved is allowed in initializing state
Deno.test("canTransition: plan_approved allowed in initializing", () => {
  const cp = makeCheckpoint({ machineState: "initializing" });
  const result = canTransition(cp, { type: "plan_approved" });
  assertEquals(result, { allowed: true });
});

// Test 2: plan_approved is rejected in dispatching state
Deno.test("canTransition: plan_approved rejected in dispatching", () => {
  const cp = makeCheckpoint({ machineState: "dispatching" });
  const result = canTransition(cp, { type: "plan_approved" });
  assertEquals(result.allowed, false);
});

// Test 3: wave_dispatched allowed in dispatching state
Deno.test("canTransition: wave_dispatched allowed in dispatching", () => {
  const cp = makeCheckpoint({ machineState: "dispatching" });
  const result = canTransition(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(result, { allowed: true });
});

// Test 4: wave_dispatched rejected in initializing state
Deno.test("canTransition: wave_dispatched rejected in initializing", () => {
  const cp = makeCheckpoint({ machineState: "initializing" });
  const result = canTransition(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(result.allowed, false);
});

// Test 5: gate_cleared allowed in gate_halted state
Deno.test("canTransition: gate_cleared allowed in gate_halted", () => {
  const cp = makeCheckpoint({ machineState: "gate_halted" });
  const result = canTransition(cp, { type: "gate_cleared", nodeId: "n1" });
  assertEquals(result, { allowed: true });
});

// Test 6: gate_cleared rejected in dispatching state
Deno.test("canTransition: gate_cleared rejected in dispatching", () => {
  const cp = makeCheckpoint({ machineState: "dispatching" });
  const result = canTransition(cp, { type: "gate_cleared", nodeId: "n1" });
  assertEquals(result.allowed, false);
});

// Test 7: retry_wave allowed in failed state
Deno.test("canTransition: retry_wave allowed in failed", () => {
  const cp = makeCheckpoint({ machineState: "failed" });
  const result = canTransition(cp, { type: "retry_wave", waveId: 1 });
  assertEquals(result, { allowed: true });
});

// Test 8: retry_wave rejected in completed state
Deno.test("canTransition: retry_wave rejected in completed", () => {
  const cp = makeCheckpoint({ machineState: "completed" });
  const result = canTransition(cp, { type: "retry_wave", waveId: 1 });
  assertEquals(result.allowed, false);
});

// ---------------------------------------------------------------------------
// transition tests
// ---------------------------------------------------------------------------

// Test 9: Full happy path through all states
Deno.test("transition: happy path initializing -> dispatching -> completed", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp0 = createCheckpoint([], graph);
  assertEquals(cp0.machineState, "initializing");

  // plan_approved -> dispatching
  const cp1 = transition(cp0, { type: "plan_approved" });
  assertEquals(cp1.machineState, "dispatching");

  // wave_dispatched
  const cp2 = transition(cp1, { type: "wave_dispatched", waveId: 1 });
  assertEquals(cp2.currentWaveId, 1);
  assertEquals(cp2.machineState, "dispatching");

  // node_completed with PR
  const cp3 = transition(cp2, {
    type: "node_completed",
    nodeId: "n1",
    prUrl: "https://github.com/org/repo/pull/1",
    prNumber: 1,
  });
  assertEquals(cp3.graph.nodes["n1"].status, "pr_created");
  assertEquals(
    cp3.graph.nodes["n1"].prUrl,
    "https://github.com/org/repo/pull/1",
  );

  // wave_completed (last wave, no merge gate) -> completed
  const cp4 = transition(cp3, { type: "wave_completed", waveId: 1 });
  assertEquals(cp4.machineState, "completed");
});

// Test 10: Failure path -> failed state
Deno.test("transition: failure path dispatching -> failed", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  let cp = createCheckpoint([], graph);
  cp = transition(cp, { type: "plan_approved" });
  cp = transition(cp, { type: "wave_dispatched", waveId: 1 });
  cp = transition(cp, {
    type: "node_failed",
    nodeId: "n1",
    reason: "Build error",
  });

  assertEquals(cp.graph.nodes["n1"].status, "failed");
  assertEquals(cp.graph.nodes["n1"].failureReason, "Build error");

  // wave_failed -> failed machine state
  cp = transition(cp, { type: "wave_failed", waveId: 1 });
  assertEquals(cp.machineState, "failed");
});

// Test 11: Retry path -> back to dispatching
Deno.test("transition: retry_wave from failed -> dispatching", () => {
  let cp = makeCheckpoint({ machineState: "failed" });
  cp = transition(cp, { type: "retry_wave", waveId: 1 });
  assertEquals(cp.machineState, "dispatching");
  assertEquals(cp.currentWaveId, 1);
});

// Test 12: Wave with merge gate -> gate_halted
Deno.test("transition: wave_completed with merge gate -> gate_halted", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const waves: Wave[] = [
    { id: 1, nodes: ["n1"], hasMergeGate: true },
    { id: 2, nodes: ["n2"], hasMergeGate: false },
  ];
  let cp = makeCheckpoint({
    machineState: "dispatching",
    graph,
    waves,
    currentWaveId: 1,
  });

  // wave_completed on a non-final wave with hasMergeGate -> gate_halted
  cp = transition(cp, { type: "wave_completed", waveId: 1 });
  assertEquals(cp.machineState, "gate_halted");
});

// Test 13: Final wave -> completed
Deno.test("transition: wave_completed on final wave -> completed", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const waves: Wave[] = [
    { id: 1, nodes: ["n1"], hasMergeGate: true },
    { id: 2, nodes: ["n2"], hasMergeGate: false },
  ];
  let cp = makeCheckpoint({
    machineState: "dispatching",
    graph,
    waves,
    currentWaveId: 2,
  });

  // wave_completed on the final wave (id 2) -> completed regardless of gate
  cp = transition(cp, { type: "wave_completed", waveId: 2 });
  assertEquals(cp.machineState, "completed");
});

// Test 14: Partial failure in waveHistory
Deno.test("transition: partial failure recorded in waveHistory", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const waves: Wave[] = [{ id: 1, nodes: ["n1", "n2"], hasMergeGate: false }];
  let cp = makeCheckpoint({
    machineState: "dispatching",
    graph,
    waves,
    currentWaveId: 1,
    waveHistory: [
      {
        waveId: 1,
        status: "partial_failure",
        completedNodes: ["n1"],
        failedNodes: ["n2"],
        prs: [],
      },
    ],
  });

  // node_failed records failure on the graph node
  cp = transition(cp, { type: "node_failed", nodeId: "n2", reason: "Timeout" });
  assertEquals(cp.graph.nodes["n2"].status, "failed");
  assertEquals(cp.graph.nodes["n2"].failureReason, "Timeout");
  // waveHistory is preserved
  assertEquals(cp.waveHistory[0].status, "partial_failure");
  assertEquals(cp.waveHistory[0].failedNodes, ["n2"]);
});

// ---------------------------------------------------------------------------
// serialize / deserialize tests
// ---------------------------------------------------------------------------

// Test 15: Round trip deep equality
Deno.test("serialize/deserialize: round trip deep equality", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const cp = createCheckpoint(
    [{ name: "test-repo", root: "/repos/test", worktrees: [] }],
    graph,
  );
  const json = serialize(cp);
  const restored = deserialize(json);
  assertEquals(restored, cp);
});

// Test 16: Version mismatch throws
Deno.test("deserialize: version mismatch throws", () => {
  const cp = makeCheckpoint();
  const raw = JSON.parse(serialize(cp));
  raw.version = "9.9.9";
  assertThrows(
    () => deserialize(JSON.stringify(raw)),
    Error,
    "Checkpoint version unsupported",
  );
});

// Test 17: Version field present in raw JSON
Deno.test("serialize: version field present in raw JSON", () => {
  const cp = makeCheckpoint();
  const raw = JSON.parse(serialize(cp));
  assertEquals(typeof raw.version, "string");
  assertEquals(raw.version, "1.0.0");
});

// ---------------------------------------------------------------------------
// Helper tests
// ---------------------------------------------------------------------------

// Test 18: currentWave returns active wave
Deno.test("currentWave: returns active wave", () => {
  const waves: Wave[] = [
    { id: 1, nodes: ["n1"], hasMergeGate: false },
    { id: 2, nodes: ["n2"], hasMergeGate: false },
  ];
  const cp = makeCheckpoint({ waves, currentWaveId: 2 });
  const wave = currentWave(cp);
  assertEquals(wave?.id, 2);
  assertEquals(wave?.nodes, ["n2"]);
});

// Test 19: currentWave returns null when no wave is active
Deno.test("currentWave: returns null when currentWaveId is null", () => {
  const cp = makeCheckpoint({ currentWaveId: null });
  assertEquals(currentWave(cp), null);
});

// Test 20: failedNodes returns all failed node IDs
Deno.test("failedNodes: returns all failed node IDs", () => {
  const graph = makeGraph([
    makeNode("n1", { status: "failed" }),
    makeNode("n2", { status: "pr_created" }),
    makeNode("n3", { status: "failed" }),
  ]);
  const cp = makeCheckpoint({ graph });
  const result = failedNodes(cp);
  result.sort();
  assertEquals(result, ["n1", "n3"]);
});

// Test 21: pendingGates returns blocked node IDs in current wave
Deno.test("pendingGates: returns blocked node IDs in current wave", () => {
  const graph = makeGraph([
    makeNode("n1", { status: "blocked" }),
    makeNode("n2", { status: "active" }),
    makeNode("n3", { status: "blocked" }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["n1", "n2", "n3"],
    hasMergeGate: true,
  }];
  const cp = makeCheckpoint({ graph, waves, currentWaveId: 1 });
  const result = pendingGates(cp);
  result.sort();
  assertEquals(result, ["n1", "n3"]);
});

// Test 22: pendingGates returns empty array when no current wave
Deno.test("pendingGates: returns empty array when no current wave", () => {
  const cp = makeCheckpoint({ currentWaveId: null });
  assertEquals(pendingGates(cp), []);
});
