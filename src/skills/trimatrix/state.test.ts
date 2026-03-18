/**
 * State machine tests for trimatrix execution lifecycle.
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
import { EdgeType, Executor, Intent, MachineState, NodeStatus, NodeType, SubgraphStrategy, Tier, WaveResultStatus } from "./types.ts";
import type { Checkpoint, Event, Graph, Node, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    repo: "test-repo",
    type: NodeType.IMPLEMENTATION,
    label: `Node ${id}`,
    worktreeBranch: `trimatrix/${id}`,
    status: NodeStatus.PENDING,
    executor: Executor.LEAD,
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
    machineState: MachineState.INITIALIZING,
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

// Test 1: plan_submitted is allowed in initializing state
Deno.test("canTransition: plan_submitted allowed in initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "plan_submitted" });
  assertEquals(result, { allowed: true });
});

// Test 2: plan_submitted is rejected in dispatching state
Deno.test("canTransition: plan_submitted rejected in dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "plan_submitted" });
  assertEquals(result.allowed, false);
});

// Test: plan_submitted rejected in plan_review
Deno.test("canTransition: plan_submitted rejected in plan_review", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = canTransition(cp, { type: "plan_submitted" });
  assertEquals(result.allowed, false);
});

// Test: plan_finalized allowed in plan_review
Deno.test("canTransition: plan_finalized allowed in plan_review", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = canTransition(cp, { type: "plan_finalized" });
  assertEquals(result, { allowed: true });
});

// Test: plan_finalized rejected in initializing
Deno.test("canTransition: plan_finalized rejected in initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "plan_finalized" });
  assertEquals(result.allowed, false);
});

// Test: plan_revision_requested allowed in plan_review
Deno.test("canTransition: plan_revision_requested allowed in plan_review", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = canTransition(cp, { type: "plan_revision_requested" });
  assertEquals(result, { allowed: true });
});

// Test: plan_revision_requested rejected in initializing
Deno.test("canTransition: plan_revision_requested rejected in initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "plan_revision_requested" });
  assertEquals(result.allowed, false);
});

// Test: cancel allowed from plan_review
Deno.test("canTransition: cancel allowed from plan_review", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result, { allowed: true });
});

// Test 3: wave_dispatched allowed in dispatching state
Deno.test("canTransition: wave_dispatched allowed in dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(result, { allowed: true });
});

// Test 4: wave_dispatched rejected in initializing state
Deno.test("canTransition: wave_dispatched rejected in initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(result.allowed, false);
});

// Test: wave_dispatched rejected in plan_review
Deno.test("canTransition: wave_dispatched rejected in plan_review", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = canTransition(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(result.allowed, false);
});

// Test: refine rejected in plan_review
Deno.test("canTransition: refine rejected in plan_review", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = canTransition(cp, { type: "refine" });
  assertEquals(result.allowed, false);
});

// Test 5: gate_cleared allowed in gate_halted state
Deno.test("canTransition: gate_cleared allowed in gate_halted", () => {
  const cp = makeCheckpoint({ machineState: MachineState.GATE_HALTED });
  const result = canTransition(cp, { type: "gate_cleared", nodeId: "n1" });
  assertEquals(result, { allowed: true });
});

// Test 6: gate_cleared rejected in dispatching state
Deno.test("canTransition: gate_cleared rejected in dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "gate_cleared", nodeId: "n1" });
  assertEquals(result.allowed, false);
});

// Test 7: retry_wave allowed in failed state
Deno.test("canTransition: retry_wave allowed in failed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.FAILED });
  const result = canTransition(cp, { type: "retry_wave", waveId: 1 });
  assertEquals(result, { allowed: true });
});

// Test 8: retry_wave rejected in completed state
Deno.test("canTransition: retry_wave rejected in completed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.COMPLETED });
  const result = canTransition(cp, { type: "retry_wave", waveId: 1 });
  assertEquals(result.allowed, false);
});

// ---------------------------------------------------------------------------
// transition tests
// ---------------------------------------------------------------------------

// Test 9: Full happy path through all states (two-step plan approval)
Deno.test("transition: happy path initializing -> plan_review -> dispatching -> completed", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp0 = createCheckpoint([], graph);
  assertEquals(cp0.machineState, MachineState.INITIALIZING);

  // plan_submitted -> plan_review
  const cp0b = transition(cp0, { type: "plan_submitted" });
  assertEquals(cp0b.machineState, MachineState.PLAN_REVIEW);

  // plan_finalized -> dispatching
  const cp1 = transition(cp0b, { type: "plan_finalized" });
  assertEquals(cp1.machineState, MachineState.DISPATCHING);

  // wave_dispatched
  const cp2 = transition(cp1, { type: "wave_dispatched", waveId: 1 });
  assertEquals(cp2.currentWaveId, 1);
  assertEquals(cp2.machineState, MachineState.DISPATCHING);

  // node_completed with PR
  const cp3 = transition(cp2, {
    type: "node_completed",
    nodeId: "n1",
    prUrl: "https://github.com/org/repo/pull/1",
    prNumber: 1,
  });
  assertEquals(cp3.graph.nodes["n1"].status, NodeStatus.PR_CREATED);
  assertEquals(
    cp3.graph.nodes["n1"].prUrl,
    "https://github.com/org/repo/pull/1",
  );

  // wave_completed (last wave, no merge gate) -> completed
  const cp4 = transition(cp3, { type: "wave_completed", waveId: 1 });
  assertEquals(cp4.machineState, MachineState.COMPLETED);
});

// Test: plan_submitted: initializing → plan_review
Deno.test("transition: plan_submitted initializing -> plan_review", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp0 = createCheckpoint([], graph);
  const cp1 = transition(cp0, { type: "plan_submitted" });
  assertEquals(cp1.machineState, MachineState.PLAN_REVIEW);
});

// Test: plan_finalized: plan_review → dispatching
Deno.test("transition: plan_finalized plan_review -> dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = transition(cp, { type: "plan_finalized" });
  assertEquals(result.machineState, MachineState.DISPATCHING);
});

// Test: plan_revision_requested: plan_review → initializing
Deno.test("transition: plan_revision_requested plan_review -> initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = transition(cp, { type: "plan_revision_requested" });
  assertEquals(result.machineState, MachineState.INITIALIZING);
});

// Test: Full cycle: initializing → plan_review → initializing → plan_review → dispatching
Deno.test("transition: full revision cycle initializing -> plan_review -> initializing -> plan_review -> dispatching", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph);
  assertEquals(cp.machineState, MachineState.INITIALIZING);

  cp = transition(cp, { type: "plan_submitted" });
  assertEquals(cp.machineState, MachineState.PLAN_REVIEW);

  cp = transition(cp, { type: "plan_revision_requested" });
  assertEquals(cp.machineState, MachineState.INITIALIZING);

  cp = transition(cp, { type: "plan_submitted" });
  assertEquals(cp.machineState, MachineState.PLAN_REVIEW);

  cp = transition(cp, { type: "plan_finalized" });
  assertEquals(cp.machineState, MachineState.DISPATCHING);
});

// Test: cancel from plan_review → cancelled
Deno.test("transition: cancel from plan_review -> cancelled", () => {
  const cp = makeCheckpoint({ machineState: MachineState.PLAN_REVIEW });
  const result = transition(cp, { type: "cancel", reason: "changed mind" });
  assertEquals(result.machineState, MachineState.CANCELLED);
  assertEquals(result.cancellationReason, "changed mind");
});

// Test 10: Failure path -> failed state
Deno.test("transition: failure path dispatching -> failed", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  let cp = createCheckpoint([], graph);
  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });
  cp = transition(cp, { type: "wave_dispatched", waveId: 1 });
  cp = transition(cp, {
    type: "node_failed",
    nodeId: "n1",
    reason: "Build error",
  });

  assertEquals(cp.graph.nodes["n1"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["n1"].failureReason, "Build error");

  // wave_failed -> failed machine state
  cp = transition(cp, { type: "wave_failed", waveId: 1 });
  assertEquals(cp.machineState, MachineState.FAILED);
});

// Test 11: Retry path -> back to dispatching
Deno.test("transition: retry_wave from failed -> dispatching", () => {
  let cp = makeCheckpoint({ machineState: MachineState.FAILED });
  cp = transition(cp, { type: "retry_wave", waveId: 1 });
  assertEquals(cp.machineState, MachineState.DISPATCHING);
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
    machineState: MachineState.DISPATCHING,
    graph,
    waves,
    currentWaveId: 1,
  });

  // wave_completed on a non-final wave with hasMergeGate -> gate_halted
  cp = transition(cp, { type: "wave_completed", waveId: 1 });
  assertEquals(cp.machineState, MachineState.GATE_HALTED);
});

// Test 13: Final wave -> completed
Deno.test("transition: wave_completed on final wave -> completed", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const waves: Wave[] = [
    { id: 1, nodes: ["n1"], hasMergeGate: true },
    { id: 2, nodes: ["n2"], hasMergeGate: false },
  ];
  let cp = makeCheckpoint({
    machineState: MachineState.DISPATCHING,
    graph,
    waves,
    currentWaveId: 2,
  });

  // wave_completed on the final wave (id 2) -> completed regardless of gate
  cp = transition(cp, { type: "wave_completed", waveId: 2 });
  assertEquals(cp.machineState, MachineState.COMPLETED);
});

// Test 14: Partial failure in waveHistory
Deno.test("transition: partial failure recorded in waveHistory", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const waves: Wave[] = [{ id: 1, nodes: ["n1", "n2"], hasMergeGate: false }];
  let cp = makeCheckpoint({
    machineState: MachineState.DISPATCHING,
    graph,
    waves,
    currentWaveId: 1,
    waveHistory: [
      {
        waveId: 1,
        status: WaveResultStatus.PARTIAL_FAILURE,
        completedNodes: ["n1"],
        failedNodes: ["n2"],
        prs: [],
      },
    ],
  });

  // node_failed records failure on the graph node
  cp = transition(cp, { type: "node_failed", nodeId: "n2", reason: "Timeout" });
  assertEquals(cp.graph.nodes["n2"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["n2"].failureReason, "Timeout");
  // waveHistory is preserved
  assertEquals(cp.waveHistory[0].status, WaveResultStatus.PARTIAL_FAILURE);
  assertEquals(cp.waveHistory[0].failedNodes, ["n2"]);
});

// Test: node_completed for repo-less → DONE
Deno.test("transition: node_completed for repo-less → DONE", () => {
  const graph = makeGraph([makeNode("n1", { repo: undefined })]);
  // Remove repo from node
  delete (graph.nodes["n1"] as Partial<Node>).repo;
  let cp = createCheckpoint([], graph);
  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });
  cp = transition(cp, { type: "wave_dispatched", waveId: 1 });
  cp = transition(cp, { type: "node_completed", nodeId: "n1" });
  assertEquals(cp.graph.nodes["n1"].status, NodeStatus.DONE);
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

// Test: 1.3.0 round-trip with DEPENDS_ON and DONE
Deno.test("serialize/deserialize: 1.3.0 round trip with DEPENDS_ON and DONE", () => {
  // Use a proper graph with two nodes
  const g2 = makeGraph(
    [makeNode("n1", { status: NodeStatus.DONE }), makeNode("n2")],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const cp = createCheckpoint([], g2);
  const json = serialize(cp);
  const restored = deserialize(json);
  assertEquals(restored.graph.nodes["n1"].status, NodeStatus.DONE);
  assertEquals(restored.graph.edges[0].type, EdgeType.DEPENDS_ON);
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
Deno.test("failedNodes: returns all FAILED node IDs", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.FAILED }),
    makeNode("n2", { status: NodeStatus.PR_CREATED }),
    makeNode("n3", { status: NodeStatus.FAILED }),
  ]);
  const cp = makeCheckpoint({ graph });
  const result = failedNodes(cp);
  result.sort();
  assertEquals(result, ["n1", "n3"]);
});

// Test 21: pendingGates returns blocked node IDs in current wave
Deno.test("pendingGates: returns BLOCKED node IDs in current wave", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.BLOCKED }),
    makeNode("n2", { status: NodeStatus.ACTIVE }),
    makeNode("n3", { status: NodeStatus.BLOCKED }),
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

// ---------------------------------------------------------------------------
// cancel transition tests
// ---------------------------------------------------------------------------

// Test 23: cancel allowed from initializing
Deno.test("canTransition: cancel allowed from initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result, { allowed: true });
});

// Test 24: cancel allowed from dispatching
Deno.test("canTransition: cancel allowed from dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result, { allowed: true });
});

// Test 25: cancel allowed from gate_halted
Deno.test("canTransition: cancel allowed from gate_halted", () => {
  const cp = makeCheckpoint({ machineState: MachineState.GATE_HALTED });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result, { allowed: true });
});

// Test 26: cancel allowed from refining
Deno.test("canTransition: cancel allowed from refining", () => {
  const cp = makeCheckpoint({ machineState: MachineState.REFINING });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result, { allowed: true });
});

// Test 27: cancel allowed from failed
Deno.test("canTransition: cancel allowed from failed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.FAILED });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result, { allowed: true });
});

// Test 28: cancel rejected from completed
Deno.test("canTransition: cancel rejected from completed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.COMPLETED });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result.allowed, false);
});

// Test 29: cancel rejected from cancelled
Deno.test("canTransition: cancel rejected from cancelled", () => {
  const cp = makeCheckpoint({ machineState: MachineState.CANCELLED });
  const result = canTransition(cp, { type: "cancel" });
  assertEquals(result.allowed, false);
});

// Test 30: transition cancel from dispatching sets cancelled state and fields
Deno.test("transition: cancel from dispatching sets machineState, cancellationReason, cancelledAt", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = transition(cp, {
    type: "cancel",
    reason: "user requested cancellation",
  });
  assertEquals(result.machineState, MachineState.CANCELLED);
  assertEquals(result.cancellationReason, "user requested cancellation");
  assertEquals(typeof result.cancelledAt, "string");
});

// Test 31: transition cancel without reason leaves cancellationReason undefined
Deno.test("transition: cancel without reason — cancellationReason is undefined", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = transition(cp, { type: "cancel" });
  assertEquals(result.machineState, MachineState.CANCELLED);
  assertEquals(result.cancellationReason, undefined);
});

// Test 32: no transitions out of cancelled — all event types rejected
Deno.test("canTransition: no transitions allowed out of cancelled state", () => {
  const cp = makeCheckpoint({ machineState: MachineState.CANCELLED });
  const events: Event[] = [
    { type: "plan_submitted" },
    { type: "plan_finalized" },
    { type: "plan_revision_requested" },
    { type: "wave_dispatched", waveId: 1 },
    { type: "node_completed", nodeId: "n1" },
    { type: "node_failed", nodeId: "n1", reason: "err" },
    { type: "gate_cleared", nodeId: "n1" },
    { type: "wave_completed", waveId: 1 },
    { type: "wave_failed", waveId: 1 },
    { type: "execution_completed" },
    { type: "retry_wave", waveId: 1 },
    { type: "refine" },
    { type: "refinement_approved" },
    { type: "cancel" },
  ];
  for (const event of events) {
    const result = canTransition(cp, event);
    assertEquals(
      result.allowed,
      false,
      `Expected cancel to be rejected from cancelled for event "${event.type}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Session field tests
// ---------------------------------------------------------------------------

// Test 33: createCheckpoint with session opts — sessionId and sessionLabel present
Deno.test("createCheckpoint: with session opts — sessionId and sessionLabel present", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph, {
    sessionId: "trimatrix-2026-01-01-abcd",
    sessionLabel: "test session",
  });
  assertEquals(cp.sessionId, "trimatrix-2026-01-01-abcd");
  assertEquals(cp.sessionLabel, "test session");
});

// Test 34: createCheckpoint without session opts — sessionId and sessionLabel undefined
Deno.test("createCheckpoint: without session opts — sessionId and sessionLabel undefined", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph);
  assertEquals(cp.sessionId, undefined);
  assertEquals(cp.sessionLabel, undefined);
});

// Test: createCheckpoint with empty repos valid
Deno.test("createCheckpoint: empty repos valid", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph);
  assertEquals(cp.repos, []);
  assertEquals(cp.machineState, MachineState.INITIALIZING);
});

// ---------------------------------------------------------------------------
// Backward compat tests
// ---------------------------------------------------------------------------

// Test 35: deserialize 1.0.0 checkpoint without session fields
Deno.test("deserialize: 1.0.0 checkpoint without session fields — sessionId undefined, refinementHistory []", () => {
  const raw = {
    version: "1.0.0",
    machineState: "initializing",
    graph: makeGraph([makeNode("n1")]),
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.sessionId, undefined);
  assertEquals(cp.refinementHistory, []);
});

// Test 36: deserialize 1.1.0 checkpoint without session fields
Deno.test("deserialize: 1.1.0 checkpoint without session fields — sessionId undefined", () => {
  const raw = {
    version: "1.1.0",
    machineState: "initializing",
    graph: makeGraph([makeNode("n1")]),
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.sessionId, undefined);
});

// Test 37: serialize/deserialize round trip with 1.2.0 session + cancel fields
Deno.test("serialize/deserialize: round trip with session and cancel fields survives", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph, {
    sessionId: "trimatrix-2026-01-01-abcd",
    sessionLabel: "test session",
  });
  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });
  cp = transition(cp, { type: "cancel", reason: "operator override" });

  const json = serialize(cp);
  const restored = deserialize(json);

  assertEquals(restored.sessionId, "trimatrix-2026-01-01-abcd");
  assertEquals(restored.sessionLabel, "test session");
  assertEquals(restored.cancellationReason, "operator override");
  assertEquals(restored.machineState, MachineState.CANCELLED);
});

// Test: deserialize 1.2.0 backward compat
Deno.test("deserialize: 1.2.0 backward compat", () => {
  const raw = {
    version: "1.2.0",
    machineState: "dispatching",
    graph: makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE })]),
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: 1,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionId: "trimatrix-2026-01-01-test",
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.version, "1.2.0");
  assertEquals(cp.machineState, MachineState.DISPATCHING);
  assertEquals(cp.repos, []);
});

// ---------------------------------------------------------------------------
// 2.0.0 — intent, tier, subgraphs
// ---------------------------------------------------------------------------

Deno.test("createCheckpoint: stores intent, tier, subgraphStrategy", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph, {
    intent: Intent.IMPLEMENT,
    tier: Tier.T2,
    subgraphStrategy: SubgraphStrategy.INDEPENDENT,
  });
  assertEquals(cp.intent, Intent.IMPLEMENT);
  assertEquals(cp.tier, Tier.T2);
  assertEquals(cp.subgraphStrategy, SubgraphStrategy.INDEPENDENT);
  assertEquals(cp.subgraphs, []);
});

Deno.test("createCheckpoint: without intent/tier — fields undefined", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph);
  assertEquals(cp.intent, undefined);
  assertEquals(cp.tier, undefined);
  assertEquals(cp.subgraphStrategy, undefined);
  assertEquals(cp.subgraphs, []);
});

Deno.test("deserialize: pre-2.0.0 checkpoint defaults subgraphs to []", () => {
  const raw = {
    version: "1.3.0",
    machineState: "initializing",
    graph: { nodes: { n1: makeNode("n1") }, edges: [] },
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.subgraphs, []);
});

Deno.test("deserialize: pre-2.0.0 checkpoint backfills executor on nodes", () => {
  // Simulate a 1.3.0 checkpoint with nodes lacking executor
  const nodeWithoutExecutor = {
    id: "n1",
    repo: "test-repo",
    type: NodeType.IMPLEMENTATION,
    label: "Node n1",
    worktreeBranch: "trimatrix/n1",
    status: NodeStatus.PENDING,
    // no executor field
  };
  const raw = {
    version: "1.3.0",
    machineState: "initializing",
    graph: { nodes: { n1: nodeWithoutExecutor }, edges: [] },
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.graph.nodes.n1.executor, Executor.LEAD);
});

Deno.test("deserialize: pre-2.3.0 checkpoint defaults episodeIds to []", () => {
  const raw = {
    version: "2.2.0",
    machineState: "initializing",
    graph: { nodes: {}, edges: [] },
    waves: [],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    subgraphs: [],
    // no episodeIds field
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.episodeIds, []);
});

Deno.test("deserialize: 2.3.0 checkpoint preserves existing episodeIds", () => {
  const raw = {
    version: "2.3.0",
    machineState: "initializing",
    graph: { nodes: {}, edges: [] },
    waves: [],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    subgraphs: [],
    episodeIds: ["ep-abc", "ep-def"],
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.episodeIds, ["ep-abc", "ep-def"]);
});

Deno.test("createCheckpoint: initializes episodeIds to empty array", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph);
  assertEquals(cp.episodeIds, []);
});

Deno.test("serialize/deserialize: round trip preserves episodeIds", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph);
  // Simulate episodes being recorded during session
  const withEpisodes = { ...cp, episodeIds: ["ep-1", "ep-2", "ep-3"] };
  const json = serialize(withEpisodes);
  const restored = deserialize(json);
  assertEquals(restored.episodeIds, ["ep-1", "ep-2", "ep-3"]);
});

Deno.test("serialize/deserialize: 2.0.0 round trip with intent and subgraphs", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph, {
    intent: Intent.INVESTIGATE,
    tier: Tier.T3,
    subgraphStrategy: SubgraphStrategy.COORDINATED,
  });
  const json = serialize(cp);
  const restored = deserialize(json);
  assertEquals(restored.intent, Intent.INVESTIGATE);
  assertEquals(restored.tier, Tier.T3);
  assertEquals(restored.subgraphStrategy, SubgraphStrategy.COORDINATED);
  assertEquals(restored.subgraphs, []);
  assertEquals(restored.version, "2.3.0");
});

// ---------------------------------------------------------------------------
// ELICIT_GATE tests
// ---------------------------------------------------------------------------

Deno.test("transition: gate_cleared with response stores elicitResponse", () => {
  const graph = makeGraph([
    makeNode("g1", {
      type: NodeType.ELICIT_GATE,
      status: NodeStatus.BLOCKED,
      elicitPrompt: "Choose an approach",
    }),
  ]);
  const waves: Wave[] = [{ id: 1, nodes: ["g1"], hasMergeGate: false }];
  const cp = makeCheckpoint({
    machineState: MachineState.GATE_HALTED,
    graph,
    waves,
    currentWaveId: 1,
  });

  const result = transition(cp, {
    type: "gate_cleared",
    nodeId: "g1",
    response: { approach: "option-a", notes: "simpler" },
  });

  assertEquals(result.graph.nodes["g1"].status, NodeStatus.ACTIVE);
  assertEquals(result.graph.nodes["g1"].elicitResponse, {
    approach: "option-a",
    notes: "simpler",
  });
  assertEquals(result.machineState, MachineState.DISPATCHING);
});

Deno.test("transition: gate_cleared without response does not set elicitResponse", () => {
  const graph = makeGraph([
    makeNode("g1", { status: NodeStatus.BLOCKED }),
  ]);
  const waves: Wave[] = [{ id: 1, nodes: ["g1"], hasMergeGate: false }];
  const cp = makeCheckpoint({
    machineState: MachineState.GATE_HALTED,
    graph,
    waves,
    currentWaveId: 1,
  });

  const result = transition(cp, { type: "gate_cleared", nodeId: "g1" });
  assertEquals(result.graph.nodes["g1"].status, NodeStatus.ACTIVE);
  assertEquals(result.graph.nodes["g1"].elicitResponse, undefined);
});

Deno.test("serialize/deserialize: round trip preserves elicit fields", () => {
  const graph = makeGraph([
    makeNode("g1", {
      type: NodeType.ELICIT_GATE,
      elicitPrompt: "Which auth strategy?",
      elicitResponse: { strategy: "jwt" },
    }),
  ]);
  const cp = createCheckpoint([], graph);
  const json = serialize(cp);
  const restored = deserialize(json);
  assertEquals(restored.graph.nodes["g1"].elicitPrompt, "Which auth strategy?");
  assertEquals(restored.graph.nodes["g1"].elicitResponse, { strategy: "jwt" });
});

Deno.test("pendingGates: returns BLOCKED ELICIT_GATE nodes in current wave", () => {
  const graph = makeGraph([
    makeNode("g1", {
      type: NodeType.ELICIT_GATE,
      status: NodeStatus.BLOCKED,
      elicitPrompt: "Question 1",
    }),
    makeNode("g2", {
      type: NodeType.ELICIT_GATE,
      status: NodeStatus.ACTIVE,
      elicitPrompt: "Question 2",
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["g1", "g2"],
    hasMergeGate: false,
  }];
  const cp = makeCheckpoint({ graph, waves, currentWaveId: 1 });
  const result = pendingGates(cp);
  assertEquals(result, ["g1"]);
});

// ---------------------------------------------------------------------------
// Checkpoint persistence decoupling tests
// ---------------------------------------------------------------------------

Deno.test("serialize: checkpoint always produces valid JSON without session fields", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const cp = createCheckpoint(
    [{ name: "test-repo", root: "/repos/test", worktrees: [] }],
    graph,
  );
  // No sessionId or sessionLabel set
  const json = serialize(cp);
  const raw = JSON.parse(json);
  assertEquals(raw.version, cp.version);
  assertEquals(Object.keys(raw.graph.nodes).length, 2);
  assertEquals(raw.sessionId, undefined);
  assertEquals(raw.sessionLabel, undefined);
});

Deno.test("serialize: checkpoint with session fields includes them", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint(
    [{ name: "test-repo", root: "/repos/test", worktrees: [] }],
    graph,
    { sessionId: "test-session-123", sessionLabel: "my-session" },
  );
  const json = serialize(cp);
  const raw = JSON.parse(json);
  assertEquals(raw.sessionId, "test-session-123");
  assertEquals(raw.sessionLabel, "my-session");
});

Deno.test("deserialize: round trip without session fields preserves graph", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const cp = createCheckpoint(
    [{ name: "test-repo", root: "/repos/test", worktrees: [] }],
    graph,
  );
  const json = serialize(cp);
  const restored = deserialize(json);
  assertEquals(Object.keys(restored.graph.nodes).length, 2);
  assertEquals(restored.graph.nodes["n1"].id, "n1");
  assertEquals(restored.graph.nodes["n2"].id, "n2");
  assertEquals(restored.machineState, MachineState.INITIALIZING);
});

Deno.test("deserialize: round trip with session fields preserves both graph and session", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint(
    [{ name: "test-repo", root: "/repos/test", worktrees: [] }],
    graph,
    { sessionId: "sess-abc", sessionLabel: "label-abc" },
  );
  const json = serialize(cp);
  const restored = deserialize(json);
  assertEquals(restored.sessionId, "sess-abc");
  assertEquals(restored.sessionLabel, "label-abc");
  assertEquals(Object.keys(restored.graph.nodes).length, 1);
});

Deno.test("deserialize: backward compat — old checkpoint without runtime state fields restores cleanly", () => {
  // Simulate a pre-decoupling checkpoint (1.0.0) with no session fields
  const raw = {
    version: "1.0.0",
    machineState: "initializing",
    graph: {
      nodes: { n1: { id: "n1", repo: "r", type: "IMPLEMENTATION", label: "N1", worktreeBranch: "b", status: "PENDING" } },
      edges: [],
    },
    waves: [{ id: 1, nodes: ["n1"], hasMergeGate: false }],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const restored = deserialize(JSON.stringify(raw));
  assertEquals(restored.machineState, "initializing");
  assertEquals(Object.keys(restored.graph.nodes).length, 1);
  assertEquals(restored.sessionId, undefined);
});
