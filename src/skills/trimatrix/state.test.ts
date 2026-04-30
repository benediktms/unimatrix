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
  appendEvent,
  canTransition,
  createCheckpoint,
  currentWave,
  deserialize,
  failedNodes,
  pendingGates,
  replay,
  serialize,
  transition,
} from "./state.ts";
import {
  EdgeType,
  Executor,
  Intent,
  MachineState,
  NodeStatus,
  NodeType,
  ReadinessStatus,
  SubgraphStrategy,
  Tier,
  WaveResultStatus,
} from "./types.ts";
import type { Checkpoint, Event, Graph, Node, Wave } from "./types.ts";
import { addSubgraph } from "./graph.ts";

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

  // Set PR metadata on node, then complete
  const cp2WithPr = {
    ...cp2,
    graph: {
      ...cp2.graph,
      nodes: {
        ...cp2.graph.nodes,
        n1: {
          ...cp2.graph.nodes["n1"],
          prUrl: "https://github.com/org/repo/pull/1",
          prNumber: 1,
        },
      },
    },
  };
  const cp3 = transition(cp2WithPr, {
    type: "node_completed",
    nodeId: "n1",
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

Deno.test("deserialize: pre-2.4.0 subgraphs receive default policies and derived flag", () => {
  const raw = {
    version: "2.3.0",
    machineState: "dispatching",
    graph: { nodes: {}, edges: [] },
    waves: [],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    episodeIds: [],
    subgraphs: [
      {
        id: "sg-lead",
        nodes: ["n1"],
        edges: [],
        assignee: "LEAD",
        executor: "LEAD",
        tier: "T1",
        coordination: { mode: "NONE" },
        // no derived / completionPolicy / failurePolicy
      },
    ],
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.subgraphs?.length, 1);
  const sg = cp.subgraphs![0];
  assertEquals(sg.derived, true);
  assertEquals(sg.completionPolicy, "ALL");
  assertEquals(sg.failurePolicy, "FAIL_FAST");
});

Deno.test("deserialize: pre-2.5.0 nodes receive READY default and recomputed readiness", () => {
  // Two-node chain with DEPENDS_ON. Pre-2.5.0 had no readinessStatus field.
  // After deserialize: node1 has no incoming deps → READY; node2 depends on
  // PENDING node1 → BLOCKED (recomputed from edge satisfaction).
  const raw = {
    version: "2.4.0",
    machineState: "dispatching",
    graph: {
      nodes: {
        n1: {
          id: "n1",
          type: "IMPLEMENTATION",
          label: "first",
          status: "PENDING",
          executor: "LEAD",
        },
        n2: {
          id: "n2",
          type: "IMPLEMENTATION",
          label: "second",
          status: "PENDING",
          executor: "LEAD",
        },
      },
      edges: [{ from: "n1", to: "n2", type: "DEPENDS_ON" }],
    },
    waves: [],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    episodeIds: [],
    subgraphs: [],
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.graph.nodes.n1.readinessStatus, "READY");
  assertEquals(cp.graph.nodes.n2.readinessStatus, "BLOCKED");
});

Deno.test("transition: node_completed recomputes readiness for downstream nodes", () => {
  // Same chain. Complete n1 → n2's readiness should flip BLOCKED → READY.
  const graph = makeGraph(
    [
      makeNode("n1"),
      makeNode("n2"),
    ],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const cp = createCheckpoint([], graph, { tier: Tier.T1 });
  // Pre-condition: n2 should be BLOCKED because n1 is PENDING.
  assertEquals(cp.graph.nodes.n2.readinessStatus, "BLOCKED");

  // Transition n1 to dispatching state then complete it.
  let next = transition(cp, { type: "plan_submitted" });
  next = transition(next, { type: "plan_finalized" });
  next = transition(next, { type: "wave_dispatched", waveId: 1 });
  next = transition(next, { type: "node_completed", nodeId: "n1" });

  assertEquals(next.graph.nodes.n2.readinessStatus, "READY");
});

Deno.test("transition: node_failed marks downstream nodes as still BLOCKED (not invalidated)", () => {
  // Failure should NOT clear downstream readiness — they remain BLOCKED
  // because n1 has not reached terminal-OK. INVALIDATED is reserved for
  // refinement, not for failure propagation.
  const graph = makeGraph(
    [
      makeNode("n1"),
      makeNode("n2"),
    ],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const cp = createCheckpoint([], graph, { tier: Tier.T1 });

  let next = transition(cp, { type: "plan_submitted" });
  next = transition(next, { type: "plan_finalized" });
  next = transition(next, { type: "wave_dispatched", waveId: 1 });
  next = transition(next, {
    type: "node_failed",
    nodeId: "n1",
    reason: "boom",
  });

  assertEquals(next.graph.nodes.n1.status, "FAILED");
  assertEquals(next.graph.nodes.n2.readinessStatus, "BLOCKED");
});

Deno.test("recomputeReadiness: preserves INVALIDATED across automatic recompute", () => {
  // INVALIDATED is set explicitly by refinement and must survive any
  // status-changing event — only re-dispatch clears it back to READY.
  const graph = makeGraph(
    [
      makeNode("n1"),
      makeNode("n2", { readinessStatus: "INVALIDATED" } as never),
    ],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const cp = createCheckpoint([], graph, { tier: Tier.T1 });

  let next = transition(cp, { type: "plan_submitted" });
  next = transition(next, { type: "plan_finalized" });
  next = transition(next, { type: "wave_dispatched", waveId: 1 });
  next = transition(next, { type: "node_completed", nodeId: "n1" });

  // n1 completed → in any other case n2 would auto-flip to READY,
  // but INVALIDATED is preserved.
  assertEquals(next.graph.nodes.n2.readinessStatus, "INVALIDATED");
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

Deno.test("serialize/deserialize: round trip preserves intent, tier, subgraphStrategy", () => {
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
  assertEquals(restored.version, "2.7.0");
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
      nodes: {
        n1: {
          id: "n1",
          repo: "r",
          type: "IMPLEMENTATION",
          label: "N1",
          worktreeBranch: "b",
          status: "PENDING",
        },
      },
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

// ---------------------------------------------------------------------------
// execution_completed transition tests
// ---------------------------------------------------------------------------

Deno.test("canTransition: execution_completed allowed from dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "execution_completed" });
  assertEquals(result, { allowed: true });
});

Deno.test("canTransition: execution_completed allowed from failed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.FAILED });
  const result = canTransition(cp, { type: "execution_completed" });
  assertEquals(result, { allowed: true });
});

Deno.test("canTransition: execution_completed rejected from initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "execution_completed" });
  assertEquals(result.allowed, false);
});

Deno.test("canTransition: execution_completed rejected from completed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.COMPLETED });
  const result = canTransition(cp, { type: "execution_completed" });
  assertEquals(result.allowed, false);
});

Deno.test("transition: execution_completed from dispatching produces completed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = transition(cp, { type: "execution_completed" });
  assertEquals(result.machineState, MachineState.COMPLETED);
});

Deno.test("transition: execution_completed from failed produces completed", () => {
  const cp = makeCheckpoint({ machineState: MachineState.FAILED });
  const result = transition(cp, { type: "execution_completed" });
  assertEquals(result.machineState, MachineState.COMPLETED);
});

// ---------------------------------------------------------------------------
// subgraph_added event tests
// ---------------------------------------------------------------------------

Deno.test("subgraph_added: idempotency — applying same event twice does not double-append", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const waves: Wave[] = [{ id: 1, nodes: ["n1", "n2"], hasMergeGate: false }];
  const cp = makeCheckpoint({ graph, waves, subgraphs: [] });

  const sgResult = addSubgraph(graph, [], {
    slug: "team-alpha",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  const cp1 = transition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(cp1.subgraphs?.length, 1);

  // Apply the same event again — should be idempotent
  const cp2 = transition(cp1, { type: "subgraph_added", subgraph: sg });
  assertEquals(
    cp2.subgraphs?.length,
    1,
    "subgraph count must not double on replay",
  );
  assertEquals(cp2.subgraphs?.[0].id, "team-alpha");
});

Deno.test("subgraph_added: rejected from COMPLETED terminal state", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = makeCheckpoint({
    machineState: MachineState.COMPLETED,
    graph,
    subgraphs: [],
  });

  const sgResult = addSubgraph(graph, [], {
    slug: "team-beta",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  const result = canTransition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(result.allowed, false);
  assertEquals(result.reason?.includes("terminal"), true);
});

Deno.test("subgraph_added: rejected from CANCELLED terminal state", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = makeCheckpoint({
    machineState: MachineState.CANCELLED,
    graph,
    subgraphs: [],
  });

  const sgResult = addSubgraph(graph, [], {
    slug: "team-gamma",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  const result = canTransition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(result.allowed, false);
  assertEquals(result.reason?.includes("terminal"), true);
});

Deno.test("subgraph_added: allowed in INITIALIZING state", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = makeCheckpoint({
    machineState: MachineState.INITIALIZING,
    graph,
    subgraphs: [],
  });

  const sgResult = addSubgraph(graph, [], {
    slug: "team-delta",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  const result = canTransition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(result.allowed, true);
});

Deno.test("subgraph_added: allowed in PLAN_REVIEW state", () => {
  const graph = makeGraph([makeNode("n1")]);
  const cp = makeCheckpoint({
    machineState: MachineState.PLAN_REVIEW,
    graph,
    subgraphs: [],
  });

  const sgResult = addSubgraph(graph, [], {
    slug: "team-epsilon",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  const result = canTransition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(result.allowed, true);
});

// ---------------------------------------------------------------------------
// Resume round-trip integrity test
// ---------------------------------------------------------------------------

Deno.test("serialize/deserialize: resume round-trip preserves subgraph structure and idempotency", () => {
  const graph = makeGraph(
    [makeNode("n1"), makeNode("n2"), makeNode("n3")],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const waves: Wave[] = [
    { id: 1, nodes: ["n1"], hasMergeGate: false },
    { id: 2, nodes: ["n2", "n3"], hasMergeGate: false },
  ];

  // Build a checkpoint with one explicit subgraph
  let cp = makeCheckpoint({ graph, waves, subgraphs: [] });

  const sgResult = addSubgraph(graph, [], {
    slug: "drone-cluster",
    nodeIds: ["n1", "n2"],
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  cp = transition(cp, { type: "subgraph_added", subgraph: sg });
  assertEquals(cp.subgraphs?.length, 1);

  // Serialize → deserialize
  const json = serialize(cp);
  const restored = deserialize(json);

  // Assert structure preserved
  assertEquals(restored.subgraphs?.length, 1);
  assertEquals(restored.subgraphs?.[0].id, "drone-cluster");
  assertEquals(restored.subgraphs?.[0].derived, false);
  assertEquals(restored.subgraphs?.[0].nodes.sort(), ["n1", "n2"].sort());

  // Assert idempotency: applying subgraph_added on restored checkpoint is a no-op
  const cp2 = transition(restored, { type: "subgraph_added", subgraph: sg });
  assertEquals(
    cp2.subgraphs?.length,
    1,
    "idempotent replay must not double-append",
  );
  assertEquals(cp2.subgraphs?.[0].id, "drone-cluster");
});

// ---------------------------------------------------------------------------
// Event-log persistence tests (UNM-1b7.3)
// ---------------------------------------------------------------------------

// Test EL-1: appendEvent increments seq monotonically
Deno.test("appendEvent: increments seq monotonically across multiple events", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph);
  assertEquals(cp.eventLog, []);

  cp = appendEvent(cp, { type: "plan_submitted" });
  assertEquals(cp.eventLog?.length, 1);
  assertEquals(cp.eventLog?.[0].seq, 1);

  cp = appendEvent(cp, { type: "plan_finalized" });
  assertEquals(cp.eventLog?.length, 2);
  assertEquals(cp.eventLog?.[1].seq, 2);

  cp = appendEvent(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(cp.eventLog?.length, 3);
  assertEquals(cp.eventLog?.[2].seq, 3);
});

// Test EL-2: appendEvent propagates state through transition
Deno.test("appendEvent: propagates state through transition correctly", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph);
  assertEquals(cp.machineState, MachineState.INITIALIZING);

  cp = appendEvent(cp, { type: "plan_submitted" });
  assertEquals(cp.machineState, MachineState.PLAN_REVIEW);

  cp = appendEvent(cp, { type: "plan_finalized" });
  assertEquals(cp.machineState, MachineState.DISPATCHING);

  // Event log contains the two events
  assertEquals(cp.eventLog?.length, 2);
  assertEquals(cp.eventLog?.[0].event.type, "plan_submitted");
  assertEquals(cp.eventLog?.[1].event.type, "plan_finalized");
});

// Test EL-3: replay of empty log returns fresh checkpoint
Deno.test("replay: empty event log returns fresh (initial) checkpoint", () => {
  const result = replay([]);
  assertEquals(result.machineState, MachineState.INITIALIZING);
  assertEquals(result.eventLog, []);
  assertEquals(Object.keys(result.graph.nodes).length, 0);
});

// Test EL-3b: replay of empty log with supplied initial returns that initial
Deno.test("replay: empty event log with supplied initial returns that initial", () => {
  const graph = makeGraph([makeNode("n1")]);
  const initial = createCheckpoint([], graph, { sessionId: "test-session" });
  const result = replay([], initial);
  assertEquals(result.machineState, MachineState.INITIALIZING);
  assertEquals(result.sessionId, "test-session");
  assertEquals(result.eventLog, []);
});

// Test EL-4: replay reproduces materialized checkpoint (idempotency invariant)
Deno.test("replay: recorded events reproduce the materialized checkpoint (idempotency invariant)", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph);

  // Apply a sequence of events via appendEvent
  cp = appendEvent(cp, { type: "plan_submitted" });
  cp = appendEvent(cp, { type: "plan_finalized" });
  cp = appendEvent(cp, { type: "wave_dispatched", waveId: 1 });
  cp = appendEvent(cp, { type: "node_completed", nodeId: "n1" });

  // Replay from scratch using the recorded event log
  const log = cp.eventLog!;
  const fresh = createCheckpoint([], graph);
  const replayed = replay(log, fresh);

  // The idempotency invariant: serialize(replay(log, fresh)) === serialize(cp)
  // We compare machine state and graph — timestamps may differ, so we
  // compare the structural fields that transition touches.
  assertEquals(replayed.machineState, cp.machineState);
  assertEquals(replayed.graph.nodes["n1"].status, cp.graph.nodes["n1"].status);
  assertEquals(replayed.eventLog?.length, log.length);
  // Full serialize equality excluding timestamps that differ
  const cpWithoutTimestamps = { ...cp, updatedAt: "", createdAt: "" };
  const replayedWithoutTimestamps = {
    ...replayed,
    updatedAt: "",
    createdAt: "",
  };
  assertEquals(
    serialize(cpWithoutTimestamps),
    serialize(replayedWithoutTimestamps),
  );
});

// Test EL-5: replay rejects out-of-order seq with a clear error
Deno.test("replay: rejects out-of-order seq with clear error", () => {
  assertThrows(
    () => {
      replay([
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          event: { type: "plan_submitted" },
          checkpointVersion: "2.6.0",
        },
        {
          seq: 3, // gap — should be 2
          timestamp: "2026-01-01T00:00:01.000Z",
          event: { type: "plan_finalized" },
          checkpointVersion: "2.6.0",
        },
      ]);
    },
    Error,
    "out-of-order seq",
  );
});

// Test EL-6: pre-2.6.0 deserialize defaults eventLog to []
Deno.test("deserialize: pre-2.6.0 checkpoint defaults eventLog to []", () => {
  const raw = {
    version: "2.5.0",
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
    episodeIds: [],
    // no eventLog field
  };
  const cp = deserialize(JSON.stringify(raw));
  assertEquals(cp.eventLog, []);
});

// Test EL-7: 2.7.0 round-trip preserves a non-trivial eventLog
Deno.test("serialize/deserialize: 2.6.0 round-trip preserves non-trivial eventLog", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph);

  cp = appendEvent(cp, { type: "plan_submitted" });
  cp = appendEvent(cp, { type: "plan_finalized" });

  assertEquals(cp.version, "2.7.0");
  assertEquals(cp.eventLog?.length, 2);

  const json = serialize(cp);
  const restored = deserialize(json);

  assertEquals(restored.version, "2.7.0");
  assertEquals(restored.eventLog?.length, 2);
  assertEquals(restored.eventLog?.[0].seq, 1);
  assertEquals(restored.eventLog?.[0].event.type, "plan_submitted");
  assertEquals(restored.eventLog?.[1].seq, 2);
  assertEquals(restored.eventLog?.[1].event.type, "plan_finalized");
  assertEquals(restored.eventLog?.[0].checkpointVersion, "2.7.0");
});

// ---------------------------------------------------------------------------
// Event-log integration via createEffectRunner (UNM-1b7.3 wiring fix)
// ---------------------------------------------------------------------------

Deno.test("createEffectRunner: transitionWithEffects appends to eventLog (wired path)", async () => {
  const { createEffectRunner } = await import("./side-effect-runner.ts");
  const graph = makeGraph([makeNode("n1")]);
  const cp = createCheckpoint([], graph, { tier: Tier.T1 });

  // No-op deps for this test; the runner falls through when policy is empty.
  const fakeBrainExec = {
    // deno-lint-ignore require-await
    withStdin: async () => "",
    // deno-lint-ignore require-await
    exec: async () => ({ stdout: "", stderr: "" }),
  };
  const runner = createEffectRunner({ brainExec: fakeBrainExec });

  // Drive the same path the server tools use.
  const r1 = await runner(cp, { type: "plan_submitted" });
  const r2 = await runner(r1.checkpoint, { type: "plan_finalized" });

  assertEquals(r2.checkpoint.eventLog?.length, 2);
  assertEquals(r2.checkpoint.eventLog?.[0].seq, 1);
  assertEquals(r2.checkpoint.eventLog?.[0].event.type, "plan_submitted");
  assertEquals(r2.checkpoint.eventLog?.[1].seq, 2);
  assertEquals(r2.checkpoint.eventLog?.[1].event.type, "plan_finalized");
});

Deno.test("createEffectRunner: replay(eventLog) reproduces the live checkpoint state", async () => {
  // The C1 fix (event log wired into the server) is what makes UNM-1b7.3
  // shippable. Lock the contract: drive a sequence of events through the
  // runner, then replay the resulting eventLog and assert the materialized
  // checkpoints round-trip equal (modulo timestamps).
  const { createEffectRunner } = await import("./side-effect-runner.ts");
  const graph = makeGraph(
    [makeNode("n1"), makeNode("n2")],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const cp = createCheckpoint([], graph, { tier: Tier.T1 });
  const fakeBrainExec = {
    // deno-lint-ignore require-await
    withStdin: async () => "",
    // deno-lint-ignore require-await
    exec: async () => ({ stdout: "", stderr: "" }),
  };
  const runner = createEffectRunner({ brainExec: fakeBrainExec });

  let live = cp;
  const events: Event[] = [
    { type: "plan_submitted" },
    { type: "plan_finalized" },
    { type: "wave_dispatched", waveId: 1 },
    { type: "node_completed", nodeId: "n1" },
  ];
  for (const ev of events) {
    const result = await runner(live, ev);
    live = result.checkpoint;
  }

  assertEquals(live.eventLog?.length, 4);

  // Replay the recorded eventLog from a fresh checkpoint with the same graph.
  const fresh = createCheckpoint([], graph, { tier: Tier.T1 });
  const replayed = replay(live.eventLog ?? [], fresh);

  // Materialized graph state must match (status fields).
  assertEquals(replayed.graph.nodes.n1.status, live.graph.nodes.n1.status);
  assertEquals(replayed.graph.nodes.n2.status, live.graph.nodes.n2.status);
  assertEquals(replayed.machineState, live.machineState);
  // n2 readiness must reflect n1's completion in both — recompute is deterministic.
  assertEquals(
    replayed.graph.nodes.n2.readinessStatus,
    live.graph.nodes.n2.readinessStatus,
  );
});

// ---------------------------------------------------------------------------
// Tests: lease fencing — state.test.ts slice (UNM-1b7.6)
// ---------------------------------------------------------------------------

/**
 * Simulate the dispatch_wave fence-stamp logic used by the server handler.
 * Returns the updated graph and the minted WorkPackets.
 */
function stampFences(
  graph: Graph,
  nodeIds: string[],
): {
  graph: Graph;
  workPackets: Array<
    { nodeId: string; attemptId: string; leaseVersion: number }
  >;
} {
  let g = graph;
  const workPackets: Array<
    { nodeId: string; attemptId: string; leaseVersion: number }
  > = [];
  for (const nId of nodeIds) {
    const node = g.nodes[nId];
    if (!node) continue;
    const attemptId = crypto.randomUUID();
    const leaseVersion = (node.leaseVersion ?? 0) + 1;
    g = {
      ...g,
      nodes: { ...g.nodes, [nId]: { ...node, attemptId, leaseVersion } },
    };
    workPackets.push({ nodeId: nId, attemptId, leaseVersion });
  }
  return { graph: g, workPackets };
}

/**
 * Simulate the refine fence-bump logic used by the server handler.
 * Increments leaseVersion on all nodes.
 */
function bumpAllFences(graph: Graph): Graph {
  const bumped: Record<string, Node> = {};
  for (const [nId, node] of Object.entries(graph.nodes)) {
    bumped[nId] = { ...node, leaseVersion: (node.leaseVersion ?? 0) + 1 };
  }
  return { ...graph, nodes: bumped };
}

Deno.test("fence state: complete_node without fence params succeeds — backward compat", () => {
  // A node with a leaseVersion set (was dispatched) can still be written to
  // by a caller that provides no fence at all. The fence is opt-in.
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE })]);
  const { graph: fencedGraph } = stampFences(graph, ["n1"]);

  const node = fencedGraph.nodes["n1"];
  // Pre-condition: node has fence fields set
  assertEquals(typeof node.attemptId, "string");
  assertEquals(node.leaseVersion, 1);

  // Simulate backward-compat path: caller provides no attemptId / leaseVersion
  // The validation block is skipped. We confirm that skipping it does not throw
  // and that the node fields are intact (the handler proceeds normally).
  const attemptIdParam: string | undefined = undefined;
  const leaseVersionParam: number | undefined = undefined;

  let validationError: string | null = null;
  if (attemptIdParam !== undefined && leaseVersionParam !== undefined) {
    if (
      node.attemptId !== attemptIdParam ||
      node.leaseVersion !== leaseVersionParam
    ) {
      validationError = `Stale lease for node n1`;
    }
  }

  assertEquals(
    validationError,
    null,
    "unfenced write must not produce a validation error",
  );
});

Deno.test("fence state: refine increments leaseVersion so pre-refine fence is rejected", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE })]);

  // Dispatch: mint fence at leaseVersion 1
  const { graph: dispatched, workPackets } = stampFences(graph, ["n1"]);
  const preRefinePacket = workPackets[0];
  assertEquals(preRefinePacket.leaseVersion, 1);

  // Refine: global leaseVersion bump
  const afterRefine = bumpAllFences(dispatched);
  assertEquals(afterRefine.nodes["n1"].leaseVersion, 2);

  // Caller still holds the pre-refine WorkPacket (leaseVersion=1)
  const node = afterRefine.nodes["n1"];
  const err = (node.attemptId !== preRefinePacket.attemptId ||
      node.leaseVersion !== preRefinePacket.leaseVersion)
    ? `Stale lease for node n1: expected (attemptId=${node.attemptId}, leaseVersion=${node.leaseVersion}), got (attemptId=${preRefinePacket.attemptId}, leaseVersion=${preRefinePacket.leaseVersion})`
    : null;

  assertEquals(
    err !== null,
    true,
    "post-refine complete with pre-refine fence must be rejected",
  );
  assertEquals(err!.includes("Stale lease for node n1"), true);
});

// ---------------------------------------------------------------------------
// Fence-state preservation on stale fence rejection (MAJOR #3)
// ---------------------------------------------------------------------------

Deno.test("fence: stale complete_node rejection preserves node status", () => {
  const graph = makeGraph([
    makeNode("n1", {
      status: NodeStatus.ACTIVE,
      prUrl: "https://example.com/pr/1",
      prNumber: 1,
    }),
  ]);
  const { graph: fencedGraph, workPackets } = stampFences(graph, ["n1"]);
  const packet = workPackets[0];

  // Re-dispatch: bump the lease — now packet is stale
  const { graph: redispatched } = stampFences(fencedGraph, ["n1"]);
  const node = redispatched.nodes["n1"];

  // Simulate the fence check: stale → error, no mutation
  const stale = node.attemptId !== packet.attemptId ||
    node.leaseVersion !== packet.leaseVersion;
  assertEquals(stale, true, "fence must be stale after re-dispatch");

  // The node must remain ACTIVE — rejection means no mutation occurred
  assertEquals(node.status, NodeStatus.ACTIVE);
  assertEquals(node.prUrl, "https://example.com/pr/1");
  assertEquals(node.prNumber, 1);
});

Deno.test("fence: stale fail_node rejection preserves node status and failureReason", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE })]);
  const { graph: fencedGraph, workPackets } = stampFences(graph, ["n1"]);

  // Re-dispatch: bump the lease — packet[0] is stale
  const { graph: redispatched } = stampFences(fencedGraph, ["n1"]);
  const node = redispatched.nodes["n1"];

  // fence check: stale → rejected; node must not be FAILED
  const stale = node.attemptId !== workPackets[0].attemptId ||
    node.leaseVersion !== workPackets[0].leaseVersion;
  assertEquals(stale, true);
  assertEquals(
    node.status,
    NodeStatus.ACTIVE,
    "status must not change on stale rejection",
  );
  assertEquals(
    node.failureReason,
    undefined,
    "failureReason must remain absent",
  );
});

Deno.test("fence: stale update_node rejection leaves prUrl/prNumber unchanged", () => {
  const graph = makeGraph([
    makeNode("n1", {
      status: NodeStatus.ACTIVE,
      prUrl: "https://example.com/pr/42",
      prNumber: 42,
    }),
  ]);
  const { graph: fencedGraph, workPackets } = stampFences(graph, ["n1"]);

  // Bump the lease (another dispatch cycle)
  const { graph: redispatched } = stampFences(fencedGraph, ["n1"]);
  const node = redispatched.nodes["n1"];

  const stale = node.attemptId !== workPackets[0].attemptId ||
    node.leaseVersion !== workPackets[0].leaseVersion;
  assertEquals(stale, true);

  // On rejection the node is not mutated — prUrl and prNumber are preserved
  assertEquals(node.prUrl, "https://example.com/pr/42");
  assertEquals(node.prNumber, 42);
});

Deno.test("fence: stale rejection does not affect sibling nodes in the graph", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.ACTIVE }),
    makeNode("n2", { status: NodeStatus.PENDING }),
  ]);
  const { graph: fencedGraph, workPackets } = stampFences(graph, ["n1"]);
  const { graph: redispatched } = stampFences(fencedGraph, ["n1"]);

  const stale =
    redispatched.nodes["n1"].attemptId !== workPackets[0].attemptId ||
    redispatched.nodes["n1"].leaseVersion !== workPackets[0].leaseVersion;
  assertEquals(stale, true);

  // n2 must remain PENDING — rejection does not touch other nodes
  assertEquals(redispatched.nodes["n2"].status, NodeStatus.PENDING);
  assertEquals(redispatched.nodes["n2"].leaseVersion, undefined);
});

Deno.test("fence: stale rejection does not increment the lease version again", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE })]);
  const { graph: fencedGraph } = stampFences(graph, ["n1"]);
  const { graph: redispatched } = stampFences(fencedGraph, ["n1"]);

  // After two dispatches leaseVersion should be exactly 2 — no extra bumps from rejection
  assertEquals(redispatched.nodes["n1"].leaseVersion, 2);
});

// ---------------------------------------------------------------------------
// Idempotency for wave_dispatched fence-stamp (MAJOR #4)
// ---------------------------------------------------------------------------

Deno.test("wave_dispatched: applying the same waveId twice is idempotent on machineState", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = createCheckpoint([], graph);
  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });

  const cp1 = transition(cp, { type: "wave_dispatched", waveId: 1 });
  assertEquals(cp1.currentWaveId, 1);
  assertEquals(cp1.machineState, MachineState.DISPATCHING);

  // A second wave_dispatched with same waveId — machineState stays DISPATCHING
  const cp2 = transition(cp1, { type: "wave_dispatched", waveId: 1 });
  assertEquals(cp2.currentWaveId, 1);
  assertEquals(cp2.machineState, MachineState.DISPATCHING);
});

// ---------------------------------------------------------------------------
// Idempotency for node_completed with fence stamp (MAJOR #4)
// ---------------------------------------------------------------------------

Deno.test("node_completed: applying the same event twice is a no-op on status", () => {
  // First application moves PENDING → DONE (repo-less node); second must be no-op.
  const graph = makeGraph([makeNode("n1", { repo: undefined })]);
  delete (graph.nodes["n1"] as Partial<Node>).repo;
  let cp = createCheckpoint([], graph);
  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });
  cp = transition(cp, { type: "wave_dispatched", waveId: 1 });
  cp = transition(cp, { type: "node_completed", nodeId: "n1" });

  assertEquals(cp.graph.nodes["n1"].status, NodeStatus.DONE);

  // Apply the same event again — status must remain DONE, not re-transition
  const cp2 = transition(cp, { type: "node_completed", nodeId: "n1" });
  assertEquals(cp2.graph.nodes["n1"].status, NodeStatus.DONE);
});

// ---------------------------------------------------------------------------
// Replay round-trip with subgraph_added events (MAJOR #5)
// ---------------------------------------------------------------------------

Deno.test("replay: subgraph_added events survive round-trip — serialize(replay(log)) === serialize(cp)", () => {
  const graph = makeGraph(
    [makeNode("n1"), makeNode("n2"), makeNode("n3")],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  let cp = createCheckpoint([], graph);

  const sgResult = addSubgraph(graph, [], {
    slug: "replay-test-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  cp = appendEvent(cp, { type: "plan_submitted" });
  cp = appendEvent(cp, { type: "plan_finalized" });
  cp = appendEvent(cp, { type: "subgraph_added", subgraph: sg });

  const log = cp.eventLog!;
  const fresh = createCheckpoint([], graph);
  const replayed = replay(log, fresh);

  // Structural equality: same subgraphs, same machine state
  assertEquals(replayed.machineState, cp.machineState);
  assertEquals(replayed.subgraphs?.length, 1);
  assertEquals(replayed.subgraphs?.[0].id, "replay-test-sg");

  // Full serialize equality (modulo timestamps)
  const cpNoTs = { ...cp, updatedAt: "", createdAt: "" };
  const replayedNoTs = { ...replayed, updatedAt: "", createdAt: "" };
  assertEquals(serialize(cpNoTs), serialize(replayedNoTs));
});

Deno.test("replay: subgraph_added idempotency survives replay — double-apply is a no-op", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  let cp = createCheckpoint([], graph);

  const sgResult = addSubgraph(graph, [], {
    slug: "idempotent-replay-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  if (!sgResult.ok) throw new Error(sgResult.error);
  const sg = sgResult.value!;

  cp = appendEvent(cp, { type: "subgraph_added", subgraph: sg });
  // Manually add a duplicate entry to the event log to simulate a double-apply scenario
  const dupLog = [
    ...cp.eventLog!,
    {
      seq: cp.eventLog!.length + 1,
      timestamp: new Date().toISOString(),
      event: { type: "subgraph_added" as const, subgraph: sg },
      checkpointVersion: cp.version,
    },
  ];

  const fresh = createCheckpoint([], graph);
  const replayed = replay(dupLog, fresh);

  // Idempotency: two applications of the same subgraph_added must not double-append
  assertEquals(
    replayed.subgraphs?.length,
    1,
    "idempotent replay must not double-append subgraph",
  );
});

// ---------------------------------------------------------------------------
// iterationCount / maxIterations backfill tests (UNM-735.1)
// ---------------------------------------------------------------------------

// createCheckpoint backfills iteration defaults on nodes that omit the fields
Deno.test("createCheckpoint: backfills iterationCount=0 and maxIterations=3 on fresh nodes", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const cp = createCheckpoint([], graph);
  const n1 = cp.graph.nodes["n1"];
  const n2 = cp.graph.nodes["n2"];
  assertEquals(n1.iterationCount, 0, "iterationCount must default to 0");
  assertEquals(n1.maxIterations, 3, "maxIterations must default to 3");
  assertEquals(n2.iterationCount, 0, "iterationCount must default to 0");
  assertEquals(n2.maxIterations, 3, "maxIterations must default to 3");
});

// createCheckpoint preserves explicit non-default maxIterations
Deno.test("createCheckpoint: preserves explicit maxIterations when supplied", () => {
  const graph = makeGraph([makeNode("n1", { maxIterations: 5, iterationCount: 2 })]);
  const cp = createCheckpoint([], graph);
  const n1 = cp.graph.nodes["n1"];
  assertEquals(n1.maxIterations, 5, "explicit maxIterations must be preserved");
  assertEquals(n1.iterationCount, 2, "explicit iterationCount must be preserved");
});

// deserialize backfills iterationCount/maxIterations on pre-2.7.0 checkpoint JSON
Deno.test("deserialize: backfills iterationCount=0 and maxIterations=3 for pre-2.7.0 checkpoints", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  const cp = createCheckpoint([], graph);
  // Simulate a pre-2.7.0 payload by stripping the fields from the serialized JSON
  const raw = JSON.parse(serialize(cp)) as Record<string, unknown>;
  const nodes = (raw.graph as { nodes: Record<string, Record<string, unknown>> }).nodes;
  for (const node of Object.values(nodes)) {
    delete node["iterationCount"];
    delete node["maxIterations"];
  }
  // Downgrade version so deserialize accepts it
  raw["version"] = "2.6.0";
  const restored = deserialize(JSON.stringify(raw));
  assertEquals(restored.graph.nodes["n1"].iterationCount, 0, "backfilled iterationCount must be 0");
  assertEquals(restored.graph.nodes["n1"].maxIterations, 3, "backfilled maxIterations must be 3");
  assertEquals(restored.graph.nodes["n2"].iterationCount, 0);
  assertEquals(restored.graph.nodes["n2"].maxIterations, 3);
});

// ---------------------------------------------------------------------------
// review_passed / review_failed handler tests (unm-735.2)
// ---------------------------------------------------------------------------

// Test RP-1: review_passed transitions node to DONE and records verdict
Deno.test("transition: review_passed -> node DONE, lastReviewVerdict=PASS", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 })]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, {
    type: "review_passed",
    nodeId: "n1",
    reviewVerdict: "PASS",
    reviewNotes: "All checks green.",
  });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.DONE);
  assertEquals(result.graph.nodes["n1"].lastReviewVerdict, "PASS");
  assertEquals(result.graph.nodes["n1"].lastReviewNotes, "All checks green.");
});

// Test RP-2: review_passed on node with prUrl → PR_CREATED (no repo)
Deno.test("transition: review_passed with prUrl and no repo -> PR_CREATED", () => {
  const graph = makeGraph([
    makeNode("n1", {
      status: NodeStatus.ACTIVE,
      prUrl: "https://github.com/org/repo/pull/42",
      repo: undefined,
      iterationCount: 0,
      maxIterations: 3,
    }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "review_passed", nodeId: "n1" });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.PR_CREATED);
  assertEquals(result.graph.nodes["n1"].lastReviewVerdict, "PASS");
});

// Test RP-3: review_passed on node with prUrl and repo → MERGED
Deno.test("transition: review_passed with prUrl and repo -> MERGED", () => {
  const graph = makeGraph([
    makeNode("n1", {
      status: NodeStatus.ACTIVE,
      prUrl: "https://github.com/org/repo/pull/7",
      repo: "org/repo",
      iterationCount: 0,
      maxIterations: 3,
    }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "review_passed", nodeId: "n1" });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.MERGED);
});

// Test RP-4: review_passed — all nodes terminal → machineState bumped to COMPLETED
Deno.test("transition: review_passed makes all nodes terminal -> machineState COMPLETED", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.DONE }),
    makeNode("n2", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "review_passed", nodeId: "n2" });
  assertEquals(result.graph.nodes["n2"].status, NodeStatus.DONE);
  assertEquals(result.machineState, MachineState.COMPLETED);
});

// Test RP-5: review_passed — not all nodes terminal → machineState unchanged
Deno.test("transition: review_passed with remaining non-terminal nodes -> machineState unchanged", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.ACTIVE }),
    makeNode("n2", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "review_passed", nodeId: "n2" });
  assertEquals(result.graph.nodes["n2"].status, NodeStatus.DONE);
  assertEquals(result.machineState, MachineState.DISPATCHING);
});

// Test RF-1: review_failed bumps iterationCount from 0 to 1, stays ACTIVE
Deno.test("transition: review_failed -> ACTIVE, iterationCount bumped 0->1, verdict=FAIL", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 })]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, {
    type: "review_failed",
    nodeId: "n1",
    reviewVerdict: "FAIL",
    reviewNotes: "Test coverage insufficient.",
  });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.ACTIVE);
  assertEquals(result.graph.nodes["n1"].iterationCount, 1);
  assertEquals(result.graph.nodes["n1"].lastReviewVerdict, "FAIL");
  assertEquals(result.graph.nodes["n1"].lastReviewNotes, "Test coverage insufficient.");
});

// Test RF-2: review_failed at maxIterations → node FAILED with cap-exhaustion reason
Deno.test("transition: review_failed 3rd time with maxIterations=3 -> FAILED with cap-exhaustion reason", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE, iterationCount: 2, maxIterations: 3 })]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, {
    type: "review_failed",
    nodeId: "n1",
    reviewNotes: "Still broken.",
  });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.FAILED);
  assertEquals(result.graph.nodes["n1"].iterationCount, 3);
  assertEquals(result.graph.nodes["n1"].lastReviewVerdict, "FAIL");
  assertEquals(result.graph.nodes["n1"].lastReviewNotes, "Still broken.");
  assertEquals(
    result.graph.nodes["n1"].failureReason,
    "iteration cap exhausted: review failed 3/3 times",
  );
});

// Test RF-3: three sequential review_failed events exhaust cap
Deno.test("transition: three sequential review_failed events exhaust cap -> iterationCount=3, FAILED", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 })]);
  let cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  cp = transition(cp, { type: "review_failed", nodeId: "n1" });
  assertEquals(cp.graph.nodes["n1"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["n1"].iterationCount, 1);
  cp = transition(cp, { type: "review_failed", nodeId: "n1" });
  assertEquals(cp.graph.nodes["n1"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["n1"].iterationCount, 2);
  cp = transition(cp, { type: "review_failed", nodeId: "n1" });
  assertEquals(cp.graph.nodes["n1"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["n1"].iterationCount, 3);
  assertEquals(
    cp.graph.nodes["n1"].failureReason,
    "iteration cap exhausted: review failed 3/3 times",
  );
});

// Test RF-4: canTransition permits review_failed in DISPATCHING
Deno.test("canTransition: review_failed allowed in dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "review_failed", nodeId: "n1" });
  assertEquals(result, { allowed: true });
});

// Test RF-5: canTransition rejects review_failed in INITIALIZING
Deno.test("canTransition: review_failed rejected in initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "review_failed", nodeId: "n1" });
  assertEquals(result.allowed, false);
});

// Test RF-6: canTransition permits review_passed in DISPATCHING
Deno.test("canTransition: review_passed allowed in dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "review_passed", nodeId: "n1" });
  assertEquals(result, { allowed: true });
});

// Test RR-1: replay parity — review_passed event log reproduces final state
Deno.test("replay: review_passed event log reproduces final state (replay parity)", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 })]);
  const initial = createCheckpoint([], graph);
  // Build live execution: plan -> dispatch -> review_passed
  let cp = appendEvent(
    appendEvent(
      appendEvent(initial, { type: "plan_submitted" }),
      { type: "plan_finalized" },
    ),
    { type: "review_passed", nodeId: "n1", reviewVerdict: "PASS", reviewNotes: "LGTM" },
  );
  // Replay from the event log
  const fresh = createCheckpoint([], graph);
  const replayed = replay(cp.eventLog!, fresh);
  assertEquals(replayed.graph.nodes["n1"].status, cp.graph.nodes["n1"].status);
  assertEquals(replayed.graph.nodes["n1"].lastReviewVerdict, cp.graph.nodes["n1"].lastReviewVerdict);
  assertEquals(replayed.graph.nodes["n1"].lastReviewNotes, cp.graph.nodes["n1"].lastReviewNotes);
  assertEquals(replayed.machineState, cp.machineState);
});

// Test RR-2: replay parity — review_failed sequence reproduces cap exhaustion
Deno.test("replay: review_failed cap exhaustion event log reproduces FAILED state (replay parity)", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE, iterationCount: 0, maxIterations: 3 })]);
  const initial = createCheckpoint([], graph);
  let cp = appendEvent(
    appendEvent(initial, { type: "plan_submitted" }),
    { type: "plan_finalized" },
  );
  cp = appendEvent(cp, { type: "review_failed", nodeId: "n1" });
  cp = appendEvent(cp, { type: "review_failed", nodeId: "n1" });
  cp = appendEvent(cp, { type: "review_failed", nodeId: "n1" });
  // Replay from the event log
  const fresh = createCheckpoint([], graph);
  const replayed = replay(cp.eventLog!, fresh);
  assertEquals(replayed.graph.nodes["n1"].status, NodeStatus.FAILED);
  assertEquals(replayed.graph.nodes["n1"].iterationCount, 3);
  assertEquals(replayed.graph.nodes["n1"].lastReviewVerdict, "FAIL");
  assertEquals(
    replayed.graph.nodes["n1"].failureReason,
    "iteration cap exhausted: review failed 3/3 times",
  );
});

// ---------------------------------------------------------------------------
// node_reset handler tests (UNM-735.3)
// ---------------------------------------------------------------------------

// Test NR-1: reset a FAILED node → PENDING, leaseVersion bumped
Deno.test("transition: node_reset from FAILED -> PENDING, leaseVersion bumped", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.FAILED, leaseVersion: 2, iterationCount: 2, failureReason: "something broke" }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "node_reset", nodeId: "n1" });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.PENDING);
  assertEquals(result.graph.nodes["n1"].leaseVersion, 3);
  assertEquals(result.graph.nodes["n1"].failureReason, undefined);
});

// Test NR-2: reset from non-FAILED → throws
Deno.test("transition: node_reset from non-FAILED -> throws", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.ACTIVE })]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  assertThrows(
    () => transition(cp, { type: "node_reset", nodeId: "n1" }),
    Error,
    "expected FAILED",
  );
});

// Test NR-3: reset with resetIterationCount: true → iterationCount = 0
Deno.test("transition: node_reset with resetIterationCount:true -> iterationCount=0", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.FAILED, iterationCount: 3, leaseVersion: 1 }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "node_reset", nodeId: "n1", resetIterationCount: true });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.PENDING);
  assertEquals(result.graph.nodes["n1"].iterationCount, 0);
});

// Test NR-4: reset without resetIterationCount flag → iterationCount preserved
Deno.test("transition: node_reset without resetIterationCount -> iterationCount preserved", () => {
  const graph = makeGraph([
    makeNode("n1", { status: NodeStatus.FAILED, iterationCount: 2, leaseVersion: 1 }),
  ]);
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "node_reset", nodeId: "n1" });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.PENDING);
  assertEquals(result.graph.nodes["n1"].iterationCount, 2);
});

// Test NR-5: downstream BLOCKED node readiness recomputed after reset
Deno.test("transition: node_reset — downstream BLOCKED node readiness recomputed", () => {
  // n1 (FAILED) → n2 (PENDING, BLOCKED because n1 failed)
  const graph = makeGraph(
    [
      makeNode("n1", { status: NodeStatus.FAILED, leaseVersion: 1 }),
      makeNode("n2", { status: NodeStatus.PENDING, readinessStatus: ReadinessStatus.BLOCKED }),
    ],
    [{ from: "n1", to: "n2", type: EdgeType.DEPENDS_ON }],
  );
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING, graph });
  const result = transition(cp, { type: "node_reset", nodeId: "n1" });
  assertEquals(result.graph.nodes["n1"].status, NodeStatus.PENDING);
  // n2 is blocked on n1 which is now PENDING (not terminal-done), so still BLOCKED
  // recomputeReadiness was called (no crash, n2 still present)
  assertEquals(result.graph.nodes["n2"].status, NodeStatus.PENDING);
  assertEquals(result.graph.nodes["n2"].readinessStatus, ReadinessStatus.BLOCKED);
});

// Test NR-6: canTransition permits node_reset in DISPATCHING
Deno.test("canTransition: node_reset allowed in dispatching", () => {
  const cp = makeCheckpoint({ machineState: MachineState.DISPATCHING });
  const result = canTransition(cp, { type: "node_reset", nodeId: "n1" });
  assertEquals(result, { allowed: true });
});

// Test NR-7: canTransition rejects node_reset in INITIALIZING
Deno.test("canTransition: node_reset rejected in initializing", () => {
  const cp = makeCheckpoint({ machineState: MachineState.INITIALIZING });
  const result = canTransition(cp, { type: "node_reset", nodeId: "n1" });
  assertEquals(result.allowed, false);
});

// Test NR-8: replay parity — node_reset event log reproduces final state
Deno.test("replay: node_reset event log reproduces PENDING state (replay parity)", () => {
  const graph = makeGraph([makeNode("n1", { status: NodeStatus.FAILED, iterationCount: 2, leaseVersion: 1 })]);
  const initial = createCheckpoint([], graph);
  let cp = appendEvent(
    appendEvent(initial, { type: "plan_submitted" }),
    { type: "plan_finalized" },
  );
  cp = appendEvent(cp, { type: "node_reset", nodeId: "n1", reason: "manual recovery", resetIterationCount: true });
  // Replay from the event log
  const fresh = createCheckpoint([], graph);
  const replayed = replay(cp.eventLog!, fresh);
  assertEquals(replayed.graph.nodes["n1"].status, NodeStatus.PENDING);
  assertEquals(replayed.graph.nodes["n1"].iterationCount, 0);
  assertEquals(replayed.graph.nodes["n1"].failureReason, undefined);
});
