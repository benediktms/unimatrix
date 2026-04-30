/**
 * Convergence loop integration scenarios (UNM-735.10).
 *
 * Six end-to-end scenarios exercising the full implement→review→fix loop
 * using the pure state machine (transition / appendEvent / replay / serialize
 * / deserialize). No I/O. No MCP server. Pure functions only.
 *
 * Scenarios:
 *   A — Happy path: 3-node graph, all converge in 1 iteration. Asserts
 *       iterationCount=0 (no retries) and all nodes DONE (oneShot pattern).
 *       avgIterations across nodes = 1.
 *   B — One node retries: cap=3, fails twice then passes. Asserts
 *       iterationCount=2 on the retried node, status DONE.
 *   C — Cap exhaustion: node fails 3×, → FAILED. Dependents gain
 *       blockedBy=[failed-id]. Upstream DONE/MERGED nodes' PR metadata,
 *       iterationCount, and lastReviewVerdict are UNCHANGED.
 *   D — reset_node recovery: FAILED node reset → PENDING, leaseVersion
 *       bumped. Re-run succeeds. iterationCount preserved (no resetIterationCount).
 *   E — Replay parity: feed event log through replay() from initial state;
 *       assert final state matches the live run that produced those events.
 *   F — Checkpoint mid-loop: serialize mid-iteration (after review_failed but
 *       before fix dispatch), deserialize, continue → same outcome as an
 *       uninterrupted run.
 *
 * Author: Four of Seven, Senary Drone Protocol of Trimatrix 702
 */

import { assertEquals } from "@std/assert";
import {
  appendEvent,
  createCheckpoint,
  deserialize,
  replay,
  serialize,
  transition,
} from "./state.ts";
import {
  EdgeType,
  Executor,
  MachineState,
  NodeStatus,
  NodeType,
  ReadinessStatus,
} from "./types.ts";
import type { Graph, Node } from "./types.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    type: NodeType.IMPLEMENTATION,
    label: `Node ${id}`,
    status: NodeStatus.ACTIVE,
    executor: Executor.LEAD,
    iterationCount: 0,
    maxIterations: 3,
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

/**
 * Build a checkpoint already in DISPATCHING state.
 * createCheckpoint → plan_submitted → plan_finalized.
 * Nodes provided should have status=ACTIVE (already dispatched).
 */
function makeDispatchingCheckpoint(nodes: Node[], edges: Graph["edges"] = []) {
  const graph = makeGraph(nodes, edges);
  let cp = createCheckpoint([], graph);
  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });
  return cp;
}

// ---------------------------------------------------------------------------
// Scenario A — Happy path: 3-node graph, all converge in 1 iteration
//
// All 3 nodes pass review immediately (iterationCount stays at 0 = 1 attempt).
// After all review_passed events the machine reaches COMPLETED.
// avgIterations = sum(iterationCount+1) / 3 = 1.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario A: happy path — 3 nodes, all pass review immediately", () => {
  const nodes = [
    makeNode("a1"),
    makeNode("a2"),
    makeNode("a3"),
  ];
  let cp = makeDispatchingCheckpoint(nodes);

  // All three nodes pass review on the first attempt.
  cp = transition(cp, { type: "review_passed", nodeId: "a1", reviewVerdict: "PASS" });
  cp = transition(cp, { type: "review_passed", nodeId: "a2", reviewVerdict: "PASS" });
  cp = transition(cp, { type: "review_passed", nodeId: "a3", reviewVerdict: "PASS" });

  // All nodes are DONE (no prUrl, no repo).
  assertEquals(cp.graph.nodes["a1"].status, NodeStatus.DONE);
  assertEquals(cp.graph.nodes["a2"].status, NodeStatus.DONE);
  assertEquals(cp.graph.nodes["a3"].status, NodeStatus.DONE);

  // oneShot: iterationCount = 0 (no retries, first attempt succeeded).
  assertEquals(cp.graph.nodes["a1"].iterationCount, 0);
  assertEquals(cp.graph.nodes["a2"].iterationCount, 0);
  assertEquals(cp.graph.nodes["a3"].iterationCount, 0);

  // All nodes have PASS verdict.
  assertEquals(cp.graph.nodes["a1"].lastReviewVerdict, "PASS");
  assertEquals(cp.graph.nodes["a2"].lastReviewVerdict, "PASS");
  assertEquals(cp.graph.nodes["a3"].lastReviewVerdict, "PASS");

  // avgIterations = (0+1 + 0+1 + 0+1) / 3 = 1.0.
  const nodeList = Object.values(cp.graph.nodes);
  const avgIterations =
    nodeList.reduce((acc, n) => acc + (n.iterationCount ?? 0) + 1, 0) /
    nodeList.length;
  assertEquals(avgIterations, 1.0);

  // Machine reached COMPLETED because all nodes are terminal.
  assertEquals(cp.machineState, MachineState.COMPLETED);
});

// ---------------------------------------------------------------------------
// Scenario B — One node retries: cap=3, fails twice then passes
//
// Node b-retry: review_failed × 2, then review_passed.
// Expected: iterationCount=2 on b-retry, status=DONE.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario B: one node retries twice then passes — iterationCount=2, DONE", () => {
  const nodes = [makeNode("b-retry", { maxIterations: 3, iterationCount: 0 })];
  let cp = makeDispatchingCheckpoint(nodes);

  // Iteration 1: review fails.
  cp = transition(cp, { type: "review_failed", nodeId: "b-retry", reviewNotes: "Missing tests." });
  assertEquals(cp.graph.nodes["b-retry"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["b-retry"].iterationCount, 1);

  // Iteration 2: review fails again.
  cp = transition(cp, { type: "review_failed", nodeId: "b-retry", reviewNotes: "Still missing." });
  assertEquals(cp.graph.nodes["b-retry"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["b-retry"].iterationCount, 2);

  // Iteration 3: review passes.
  cp = transition(cp, {
    type: "review_passed",
    nodeId: "b-retry",
    reviewVerdict: "PASS",
    reviewNotes: "Coverage added.",
  });

  // Node converged on third attempt.
  assertEquals(cp.graph.nodes["b-retry"].status, NodeStatus.DONE);
  assertEquals(cp.graph.nodes["b-retry"].iterationCount, 2);
  assertEquals(cp.graph.nodes["b-retry"].lastReviewVerdict, "PASS");

  // Machine COMPLETED: only one node, now DONE.
  assertEquals(cp.machineState, MachineState.COMPLETED);
});

// ---------------------------------------------------------------------------
// Scenario C — Cap exhaustion: cap=3, fails 3×, → FAILED
//
// Dependents: c-dep becomes BLOCKED with blockedBy=[c-target].
// Upstream: c-upstream (DONE, prUrl, iterationCount=2, PASS verdict) UNCHANGED.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario C: cap exhaustion — FAILED, dependent blocked, upstream preserved", () => {
  const upstream = makeNode("c-upstream", {
    status: NodeStatus.DONE,
    iterationCount: 2,
    maxIterations: 3,
    lastReviewVerdict: "PASS",
    lastReviewNotes: "Upstream done.",
    prUrl: "https://github.com/org/repo/pull/7",
    readinessStatus: ReadinessStatus.READY,
  });
  const target = makeNode("c-target", {
    status: NodeStatus.ACTIVE,
    maxIterations: 3,
    iterationCount: 0,
    readinessStatus: ReadinessStatus.READY,
  });
  const dep = makeNode("c-dep", {
    status: NodeStatus.PENDING,
    maxIterations: 3,
    iterationCount: 0,
    readinessStatus: ReadinessStatus.BLOCKED,
  });

  let cp = makeDispatchingCheckpoint(
    [upstream, target, dep],
    [
      { from: "c-upstream", to: "c-target", type: EdgeType.DEPENDS_ON },
      { from: "c-target", to: "c-dep", type: EdgeType.DEPENDS_ON },
    ],
  );

  // Three review failures exhaust the cap.
  cp = transition(cp, { type: "review_failed", nodeId: "c-target" });
  assertEquals(cp.graph.nodes["c-target"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["c-target"].iterationCount, 1);

  cp = transition(cp, { type: "review_failed", nodeId: "c-target" });
  assertEquals(cp.graph.nodes["c-target"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["c-target"].iterationCount, 2);

  cp = transition(cp, { type: "review_failed", nodeId: "c-target", reviewNotes: "Cap hit." });
  assertEquals(cp.graph.nodes["c-target"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["c-target"].iterationCount, 3);
  assertEquals(
    cp.graph.nodes["c-target"].failureReason,
    "iteration cap exhausted: review failed 3/3 times",
  );
  assertEquals(cp.graph.nodes["c-target"].lastReviewVerdict, "FAIL");

  // c-dep becomes BLOCKED with blockedBy=[c-target].
  assertEquals(cp.graph.nodes["c-dep"].readinessStatus, ReadinessStatus.BLOCKED);
  assertEquals(cp.graph.nodes["c-dep"].blockedBy, ["c-target"]);

  // c-upstream UNCHANGED — PR metadata, iterationCount, verdict all intact.
  const up = cp.graph.nodes["c-upstream"];
  assertEquals(up.status, NodeStatus.DONE);
  assertEquals(up.iterationCount, 2);
  assertEquals(up.lastReviewVerdict, "PASS");
  assertEquals(up.lastReviewNotes, "Upstream done.");
  assertEquals(up.prUrl, "https://github.com/org/repo/pull/7");
  assertEquals(up.blockedBy, undefined);
});

// ---------------------------------------------------------------------------
// Scenario D — reset_node recovery
//
// FAILED node reset → PENDING, leaseVersion bumped.
// Re-run: review_passed → DONE.
// iterationCount preserved (not reset) — user chose default (no resetIterationCount).
// Report: recovery path from FAILED to DONE in the same session.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario D: reset_node recovery — FAILED → PENDING → DONE, iterationCount preserved", () => {
  // Start with a node that has already exhausted 3 iterations and is FAILED.
  const failedNode = makeNode("d-node", {
    status: NodeStatus.FAILED,
    iterationCount: 3,
    maxIterations: 3,
    leaseVersion: 2,
    failureReason: "iteration cap exhausted: review failed 3/3 times",
    lastReviewVerdict: "FAIL",
  });

  let cp = makeDispatchingCheckpoint([failedNode]);

  // Verify precondition: node is FAILED before reset.
  assertEquals(cp.graph.nodes["d-node"].status, NodeStatus.FAILED);

  // Apply node_reset (without resetIterationCount — preserve count).
  cp = transition(cp, {
    type: "node_reset",
    nodeId: "d-node",
    reason: "operator recovery after root cause fix",
  });

  // Node is now PENDING with bumped leaseVersion and cleared failureReason.
  assertEquals(cp.graph.nodes["d-node"].status, NodeStatus.PENDING);
  assertEquals(cp.graph.nodes["d-node"].leaseVersion, 3);
  assertEquals(cp.graph.nodes["d-node"].failureReason, undefined);

  // iterationCount preserved — still 3.
  assertEquals(cp.graph.nodes["d-node"].iterationCount, 3);

  // Re-run: node is dispatched again (simulate by setting ACTIVE via a fresh
  // graph mutation — real dispatch would set ACTIVE; here we drive state directly).
  // We inline-update the node to ACTIVE to apply review_passed.
  cp = {
    ...cp,
    graph: {
      ...cp.graph,
      nodes: {
        ...cp.graph.nodes,
        "d-node": { ...cp.graph.nodes["d-node"], status: NodeStatus.ACTIVE },
      },
    },
  };

  // Operator dispatches fix. Review passes this time.
  cp = transition(cp, {
    type: "review_passed",
    nodeId: "d-node",
    reviewVerdict: "PASS",
    reviewNotes: "Root cause fixed.",
  });

  // Node converged.
  assertEquals(cp.graph.nodes["d-node"].status, NodeStatus.DONE);
  assertEquals(cp.graph.nodes["d-node"].lastReviewVerdict, "PASS");

  // iterationCount still 3 — the recovery run does not add to it
  // (review_passed does not bump iterationCount).
  assertEquals(cp.graph.nodes["d-node"].iterationCount, 3);

  // Machine COMPLETED.
  assertEquals(cp.machineState, MachineState.COMPLETED);
});

// ---------------------------------------------------------------------------
// Scenario E — Replay parity
//
// Build a live run that produces a convergence event log:
//   plan_submitted → plan_finalized → review_failed (e1) × 2 → review_passed (e1)
//   → review_passed (e2) → review_passed (e3)
// Feed the same event log through replay() from the initial state.
// Assert final state (node statuses, iterationCounts, verdicts, machineState)
// is bit-for-bit identical to the live run.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario E: replay parity — event log reproduces live multi-node convergence run", () => {
  const nodes = [
    makeNode("e1", { iterationCount: 0, maxIterations: 3 }),
    makeNode("e2", { iterationCount: 0, maxIterations: 3 }),
    makeNode("e3", { iterationCount: 0, maxIterations: 3 }),
  ];
  const graph = makeGraph(nodes);
  const initial = createCheckpoint([], graph);

  // Live run via appendEvent (logs every event).
  let live = appendEvent(initial, { type: "plan_submitted" });
  live = appendEvent(live, { type: "plan_finalized" });

  // e1 fails twice then passes.
  live = appendEvent(live, { type: "review_failed", nodeId: "e1", reviewNotes: "Round 1 fail." });
  live = appendEvent(live, { type: "review_failed", nodeId: "e1", reviewNotes: "Round 2 fail." });
  live = appendEvent(live, { type: "review_passed", nodeId: "e1", reviewVerdict: "PASS", reviewNotes: "Fixed." });

  // e2 and e3 pass immediately.
  live = appendEvent(live, { type: "review_passed", nodeId: "e2", reviewVerdict: "PASS" });
  live = appendEvent(live, { type: "review_passed", nodeId: "e3", reviewVerdict: "PASS" });

  // Replay from the same initial checkpoint using the captured event log.
  const freshInitial = createCheckpoint([], graph);
  const replayed = replay(live.eventLog!, freshInitial);

  // Node statuses match.
  assertEquals(replayed.graph.nodes["e1"].status, live.graph.nodes["e1"].status);
  assertEquals(replayed.graph.nodes["e2"].status, live.graph.nodes["e2"].status);
  assertEquals(replayed.graph.nodes["e3"].status, live.graph.nodes["e3"].status);

  // iterationCounts match.
  assertEquals(replayed.graph.nodes["e1"].iterationCount, live.graph.nodes["e1"].iterationCount);
  assertEquals(replayed.graph.nodes["e2"].iterationCount, live.graph.nodes["e2"].iterationCount);
  assertEquals(replayed.graph.nodes["e3"].iterationCount, live.graph.nodes["e3"].iterationCount);

  // Review verdicts match.
  assertEquals(replayed.graph.nodes["e1"].lastReviewVerdict, live.graph.nodes["e1"].lastReviewVerdict);
  assertEquals(replayed.graph.nodes["e2"].lastReviewVerdict, live.graph.nodes["e2"].lastReviewVerdict);
  assertEquals(replayed.graph.nodes["e3"].lastReviewVerdict, live.graph.nodes["e3"].lastReviewVerdict);

  // Review notes match.
  assertEquals(replayed.graph.nodes["e1"].lastReviewNotes, live.graph.nodes["e1"].lastReviewNotes);

  // Machine state matches.
  assertEquals(replayed.machineState, live.machineState);
  assertEquals(replayed.machineState, MachineState.COMPLETED);

  // Spot-check concrete values.
  assertEquals(replayed.graph.nodes["e1"].iterationCount, 2);
  assertEquals(replayed.graph.nodes["e1"].status, NodeStatus.DONE);
});

// ---------------------------------------------------------------------------
// Scenario F — Checkpoint mid-loop
//
// Run: plan_submitted → plan_finalized → review_failed (f-node, iteration 1).
// At this point we serialize the checkpoint (simulating save_checkpoint).
// Deserialize it back (simulating restore_checkpoint).
// Continue: review_passed → DONE.
// Assert: same final state as an uninterrupted run that did the exact same events.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario F: checkpoint mid-loop — serialize after review_failed, restore, continue, same outcome", () => {
  const nodes = [makeNode("f-node", { iterationCount: 0, maxIterations: 3 })];
  const graph = makeGraph(nodes);
  let cp = createCheckpoint([], graph);

  cp = transition(cp, { type: "plan_submitted" });
  cp = transition(cp, { type: "plan_finalized" });

  // First review cycle fails (iterationCount goes to 1).
  cp = transition(cp, {
    type: "review_failed",
    nodeId: "f-node",
    reviewNotes: "Coverage gap.",
  });
  assertEquals(cp.graph.nodes["f-node"].iterationCount, 1);
  assertEquals(cp.graph.nodes["f-node"].status, NodeStatus.ACTIVE);

  // CHECKPOINT SAVE: serialize mid-iteration.
  const savedJson = serialize(cp);

  // CHECKPOINT RESTORE: deserialize back.
  const restored = deserialize(savedJson);

  // Restored state is identical to pre-save state.
  assertEquals(restored.graph.nodes["f-node"].iterationCount, 1);
  assertEquals(restored.graph.nodes["f-node"].status, NodeStatus.ACTIVE);
  assertEquals(restored.graph.nodes["f-node"].lastReviewVerdict, "FAIL");
  assertEquals(restored.machineState, MachineState.DISPATCHING);

  // Continue from restored checkpoint: fix is dispatched, review passes.
  const continued = transition(restored, {
    type: "review_passed",
    nodeId: "f-node",
    reviewVerdict: "PASS",
    reviewNotes: "Coverage added after restore.",
  });

  // UNINTERRUPTED reference: replay the same events from scratch for comparison.
  let reference = createCheckpoint([], graph);
  reference = transition(reference, { type: "plan_submitted" });
  reference = transition(reference, { type: "plan_finalized" });
  reference = transition(reference, { type: "review_failed", nodeId: "f-node", reviewNotes: "Coverage gap." });
  reference = transition(reference, {
    type: "review_passed",
    nodeId: "f-node",
    reviewVerdict: "PASS",
    reviewNotes: "Coverage added after restore.",
  });

  // Both paths converge to the same outcome.
  assertEquals(continued.graph.nodes["f-node"].status, reference.graph.nodes["f-node"].status);
  assertEquals(continued.graph.nodes["f-node"].iterationCount, reference.graph.nodes["f-node"].iterationCount);
  assertEquals(continued.graph.nodes["f-node"].lastReviewVerdict, reference.graph.nodes["f-node"].lastReviewVerdict);
  assertEquals(continued.machineState, reference.machineState);

  // Concrete checks.
  assertEquals(continued.graph.nodes["f-node"].status, NodeStatus.DONE);
  assertEquals(continued.graph.nodes["f-node"].iterationCount, 1);
  assertEquals(continued.graph.nodes["f-node"].lastReviewVerdict, "PASS");
  assertEquals(continued.machineState, MachineState.COMPLETED);
});
