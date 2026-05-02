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
 *   G — Multi-failure cascade: two independent FAILs in one saga. Graph:
 *       A→B, C→D. Both A and C FAIL (cap exhausted). Assert B and D are
 *       independently blocked by their respective failed predecessors only.
 *   H — reset_node race vs ACTIVE drone: assert node_reset throws when node
 *       is ACTIVE. Then test the post-completion-failure fence: dispatch →
 *       fail_node → reset_node → re-dispatch; stale late completion is rejected.
 *   I — Cap exhaustion + resetIterationCount:true end-to-end recovery: fail
 *       3× → FAILED (iterationCount=3). reset_node with resetIterationCount:true
 *       → PENDING (iterationCount=0). Re-dispatch → review_passed → DONE.
 *   J — Cross-brain saga via mock checkpoints: two repos, nodes split across
 *       both. Assert per-repo iteration isolation and aggregate saga_report.
 *
 * Originating tasks: UNM-735, UNM-735.16
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  appendEvent,
  createCheckpoint,
  deserialize,
  replay,
  serialize,
  transition,
} from "./state.ts";
import { buildSagaReport } from "./saga_report.ts";
import {
  EdgeType,
  Executor,
  MachineState,
  NodeStatus,
  NodeType,
  ReadinessStatus,
} from "./types.ts";
import type { Graph, Node, RepoMetadata } from "./types.ts";

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
  cp = transition(cp, {
    type: "review_passed",
    nodeId: "a1",
    reviewVerdict: "PASS",
  });
  cp = transition(cp, {
    type: "review_passed",
    nodeId: "a2",
    reviewVerdict: "PASS",
  });
  cp = transition(cp, {
    type: "review_passed",
    nodeId: "a3",
    reviewVerdict: "PASS",
  });

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
  cp = transition(cp, {
    type: "review_failed",
    nodeId: "b-retry",
    reviewNotes: "Missing tests.",
  });
  assertEquals(cp.graph.nodes["b-retry"].status, NodeStatus.ACTIVE);
  assertEquals(cp.graph.nodes["b-retry"].iterationCount, 1);

  // Iteration 2: review fails again.
  cp = transition(cp, {
    type: "review_failed",
    nodeId: "b-retry",
    reviewNotes: "Still missing.",
  });
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

  cp = transition(cp, {
    type: "review_failed",
    nodeId: "c-target",
    reviewNotes: "Cap hit.",
  });
  assertEquals(cp.graph.nodes["c-target"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["c-target"].iterationCount, 3);
  assertEquals(
    cp.graph.nodes["c-target"].failureReason,
    "iteration cap exhausted: review failed 3/3 times",
  );
  assertEquals(cp.graph.nodes["c-target"].lastReviewVerdict, "FAIL");

  // c-dep becomes BLOCKED with blockedBy=[c-target].
  assertEquals(
    cp.graph.nodes["c-dep"].readinessStatus,
    ReadinessStatus.BLOCKED,
  );
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
  live = appendEvent(live, {
    type: "review_failed",
    nodeId: "e1",
    reviewNotes: "Round 1 fail.",
  });
  live = appendEvent(live, {
    type: "review_failed",
    nodeId: "e1",
    reviewNotes: "Round 2 fail.",
  });
  live = appendEvent(live, {
    type: "review_passed",
    nodeId: "e1",
    reviewVerdict: "PASS",
    reviewNotes: "Fixed.",
  });

  // e2 and e3 pass immediately.
  live = appendEvent(live, {
    type: "review_passed",
    nodeId: "e2",
    reviewVerdict: "PASS",
  });
  live = appendEvent(live, {
    type: "review_passed",
    nodeId: "e3",
    reviewVerdict: "PASS",
  });

  // Replay from the same initial checkpoint using the captured event log.
  const freshInitial = createCheckpoint([], graph);
  const replayed = replay(live.eventLog!, freshInitial);

  // Node statuses match.
  assertEquals(
    replayed.graph.nodes["e1"].status,
    live.graph.nodes["e1"].status,
  );
  assertEquals(
    replayed.graph.nodes["e2"].status,
    live.graph.nodes["e2"].status,
  );
  assertEquals(
    replayed.graph.nodes["e3"].status,
    live.graph.nodes["e3"].status,
  );

  // iterationCounts match.
  assertEquals(
    replayed.graph.nodes["e1"].iterationCount,
    live.graph.nodes["e1"].iterationCount,
  );
  assertEquals(
    replayed.graph.nodes["e2"].iterationCount,
    live.graph.nodes["e2"].iterationCount,
  );
  assertEquals(
    replayed.graph.nodes["e3"].iterationCount,
    live.graph.nodes["e3"].iterationCount,
  );

  // Review verdicts match.
  assertEquals(
    replayed.graph.nodes["e1"].lastReviewVerdict,
    live.graph.nodes["e1"].lastReviewVerdict,
  );
  assertEquals(
    replayed.graph.nodes["e2"].lastReviewVerdict,
    live.graph.nodes["e2"].lastReviewVerdict,
  );
  assertEquals(
    replayed.graph.nodes["e3"].lastReviewVerdict,
    live.graph.nodes["e3"].lastReviewVerdict,
  );

  // Review notes match.
  assertEquals(
    replayed.graph.nodes["e1"].lastReviewNotes,
    live.graph.nodes["e1"].lastReviewNotes,
  );

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
  reference = transition(reference, {
    type: "review_failed",
    nodeId: "f-node",
    reviewNotes: "Coverage gap.",
  });
  reference = transition(reference, {
    type: "review_passed",
    nodeId: "f-node",
    reviewVerdict: "PASS",
    reviewNotes: "Coverage added after restore.",
  });

  // Both paths converge to the same outcome.
  assertEquals(
    continued.graph.nodes["f-node"].status,
    reference.graph.nodes["f-node"].status,
  );
  assertEquals(
    continued.graph.nodes["f-node"].iterationCount,
    reference.graph.nodes["f-node"].iterationCount,
  );
  assertEquals(
    continued.graph.nodes["f-node"].lastReviewVerdict,
    reference.graph.nodes["f-node"].lastReviewVerdict,
  );
  assertEquals(continued.machineState, reference.machineState);

  // Concrete checks.
  assertEquals(continued.graph.nodes["f-node"].status, NodeStatus.DONE);
  assertEquals(continued.graph.nodes["f-node"].iterationCount, 1);
  assertEquals(continued.graph.nodes["f-node"].lastReviewVerdict, "PASS");
  assertEquals(continued.machineState, MachineState.COMPLETED);
});

// ---------------------------------------------------------------------------
// Scenario G — Multi-failure cascade
//
// Graph: A → B, C → D. A and C both exhaust their cap (3 review_failed each).
// Assert:
//   - B.readinessStatus === BLOCKED, B.blockedBy === ["g-a"]
//   - D.readinessStatus === BLOCKED, D.blockedBy === ["g-c"]
//   - B and D are NOT in each other's blockedBy
//   - machineState is DISPATCHING (PENDING/BLOCKED dependents are not terminal)
// ---------------------------------------------------------------------------

Deno.test("convergence scenario G: multi-failure cascade — independent A→B, C→D FAIL isolation", () => {
  const nodeA = makeNode("g-a", {
    status: NodeStatus.ACTIVE,
    maxIterations: 3,
    iterationCount: 0,
    readinessStatus: ReadinessStatus.READY,
  });
  const nodeB = makeNode("g-b", {
    status: NodeStatus.PENDING,
    maxIterations: 3,
    iterationCount: 0,
    readinessStatus: ReadinessStatus.BLOCKED,
  });
  const nodeC = makeNode("g-c", {
    status: NodeStatus.ACTIVE,
    maxIterations: 3,
    iterationCount: 0,
    readinessStatus: ReadinessStatus.READY,
  });
  const nodeD = makeNode("g-d", {
    status: NodeStatus.PENDING,
    maxIterations: 3,
    iterationCount: 0,
    readinessStatus: ReadinessStatus.BLOCKED,
  });

  let cp = makeDispatchingCheckpoint(
    [nodeA, nodeB, nodeC, nodeD],
    [
      { from: "g-a", to: "g-b", type: EdgeType.DEPENDS_ON },
      { from: "g-c", to: "g-d", type: EdgeType.DEPENDS_ON },
    ],
  );

  // Exhaust cap on g-a (3 failures).
  cp = transition(cp, { type: "review_failed", nodeId: "g-a" });
  cp = transition(cp, { type: "review_failed", nodeId: "g-a" });
  cp = transition(cp, {
    type: "review_failed",
    nodeId: "g-a",
    reviewNotes: "Cap hit on A.",
  });

  assertEquals(cp.graph.nodes["g-a"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["g-a"].iterationCount, 3);

  // Exhaust cap on g-c (3 failures).
  cp = transition(cp, { type: "review_failed", nodeId: "g-c" });
  cp = transition(cp, { type: "review_failed", nodeId: "g-c" });
  cp = transition(cp, {
    type: "review_failed",
    nodeId: "g-c",
    reviewNotes: "Cap hit on C.",
  });

  assertEquals(cp.graph.nodes["g-c"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["g-c"].iterationCount, 3);

  // g-b is blocked by g-a only — not by g-c.
  assertEquals(
    cp.graph.nodes["g-b"].readinessStatus,
    ReadinessStatus.BLOCKED,
  );
  assertEquals(cp.graph.nodes["g-b"].blockedBy, ["g-a"]);

  // g-d is blocked by g-c only — not by g-a.
  assertEquals(
    cp.graph.nodes["g-d"].readinessStatus,
    ReadinessStatus.BLOCKED,
  );
  assertEquals(cp.graph.nodes["g-d"].blockedBy, ["g-c"]);

  // Cross-contamination check: g-b does not list g-c; g-d does not list g-a.
  assertEquals((cp.graph.nodes["g-b"].blockedBy ?? []).includes("g-c"), false);
  assertEquals((cp.graph.nodes["g-d"].blockedBy ?? []).includes("g-a"), false);

  // machineState: PENDING dependents are not terminal — saga stays DISPATCHING.
  assertEquals(cp.machineState, MachineState.DISPATCHING);
});

// ---------------------------------------------------------------------------
// Scenario H — reset_node race against ACTIVE drone
//
// Part 1: node is ACTIVE (dispatched, leaseVersion=1). node_reset must throw
//         because only FAILED nodes may be reset.
//
// Part 2: dispatch → review_failed (FAILED) → node_reset (PENDING, leaseVersion
//         bumped) → re-dispatch (ACTIVE). A stale late review_passed from the
//         ORIGINAL drone, carrying the OLD leaseVersion, would be fence-rejected
//         at the server layer (leaseVersion mismatch). We verify leaseVersion
//         increments correctly so the fence can operate.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario H: reset_node throws on ACTIVE node; post-fail reset bumps leaseVersion for fence", () => {
  // Part 1: ACTIVE node — reset must throw.
  const activeNode = makeNode("h-node", {
    status: NodeStatus.ACTIVE,
    leaseVersion: 1,
    maxIterations: 3,
    iterationCount: 0,
  });
  const cp1 = makeDispatchingCheckpoint([activeNode]);

  assertThrows(
    () =>
      transition(cp1, {
        type: "node_reset",
        nodeId: "h-node",
        reason: "operator recovery",
      }),
    Error,
    `Cannot reset node "h-node" — node is ${NodeStatus.ACTIVE}, expected ${NodeStatus.FAILED}`,
  );

  // Part 2: dispatch → fail_node (review_failed × 3) → reset_node → re-dispatch.
  const freshNode = makeNode("h-node2", {
    status: NodeStatus.ACTIVE,
    leaseVersion: 1,
    maxIterations: 3,
    iterationCount: 0,
  });
  let cp2 = makeDispatchingCheckpoint([freshNode]);

  // Exhaust cap: 3 review_failed → FAILED.
  cp2 = transition(cp2, { type: "review_failed", nodeId: "h-node2" });
  cp2 = transition(cp2, { type: "review_failed", nodeId: "h-node2" });
  cp2 = transition(cp2, { type: "review_failed", nodeId: "h-node2" });

  assertEquals(cp2.graph.nodes["h-node2"].status, NodeStatus.FAILED);
  const leaseAfterFail = cp2.graph.nodes["h-node2"].leaseVersion ?? 0;

  // node_reset: FAILED → PENDING, leaseVersion bumped.
  cp2 = transition(cp2, {
    type: "node_reset",
    nodeId: "h-node2",
    reason: "operator recovery after root cause fix",
  });

  assertEquals(cp2.graph.nodes["h-node2"].status, NodeStatus.PENDING);
  assertEquals(
    cp2.graph.nodes["h-node2"].leaseVersion,
    leaseAfterFail + 1,
    "leaseVersion must increment on reset so stale in-flight WorkPackets are fence-rejected",
  );
  assertEquals(cp2.graph.nodes["h-node2"].failureReason, undefined);

  // Simulate re-dispatch: set ACTIVE again.
  cp2 = {
    ...cp2,
    graph: {
      ...cp2.graph,
      nodes: {
        ...cp2.graph.nodes,
        "h-node2": {
          ...cp2.graph.nodes["h-node2"],
          status: NodeStatus.ACTIVE,
        },
      },
    },
  };

  const leaseAtRedispatch = cp2.graph.nodes["h-node2"].leaseVersion!;

  // New drone completes successfully.
  cp2 = transition(cp2, {
    type: "review_passed",
    nodeId: "h-node2",
    reviewVerdict: "PASS",
    reviewNotes: "Fixed after reset.",
  });

  assertEquals(cp2.graph.nodes["h-node2"].status, NodeStatus.DONE);
  assertEquals(cp2.graph.nodes["h-node2"].lastReviewVerdict, "PASS");

  // The original drone's stale WorkPacket would carry leaseVersion = leaseAfterFail.
  // The new active lease is leaseAtRedispatch = leaseAfterFail + 1.
  // A server-side fence check (leaseVersion === node.leaseVersion) would reject it.
  assertEquals(leaseAtRedispatch > leaseAfterFail, true);

  // Simulate the fence-rejection path: the original drone returns AFTER reset
  // and tries to write with its stale leaseVersion. The server-side fence in
  // update_node/complete_node/fail_node compares the provided leaseVersion to
  // the node's current leaseVersion; mismatch is rejected.
  const currentNode = cp2.graph.nodes["h-node2"];
  const stalePacket = {
    attemptId: "drone-original-attempt",
    leaseVersion: leaseAfterFail, // pre-reset value
  };
  const fenceMatches = stalePacket.leaseVersion === currentNode.leaseVersion;
  assertEquals(
    fenceMatches,
    false,
    "stale leaseVersion from a pre-reset attempt MUST NOT match the current lease",
  );
});

// ---------------------------------------------------------------------------
// Scenario I — Cap exhaustion + resetIterationCount:true end-to-end recovery
//
// Node fails 3× → FAILED with iterationCount=3.
// Call node_reset with resetIterationCount:true → PENDING, iterationCount=0.
// Re-dispatch: review_passed → DONE with iterationCount=0.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario I: cap exhaustion + resetIterationCount:true — full recovery to DONE with iterationCount=0", () => {
  const targetNode = makeNode("i-node", {
    status: NodeStatus.ACTIVE,
    maxIterations: 3,
    iterationCount: 0,
    leaseVersion: 1,
  });

  let cp = makeDispatchingCheckpoint([targetNode]);

  // Three review failures exhaust the cap.
  cp = transition(cp, { type: "review_failed", nodeId: "i-node" });
  cp = transition(cp, { type: "review_failed", nodeId: "i-node" });
  cp = transition(cp, {
    type: "review_failed",
    nodeId: "i-node",
    reviewNotes: "Cap hit.",
  });

  assertEquals(cp.graph.nodes["i-node"].status, NodeStatus.FAILED);
  assertEquals(cp.graph.nodes["i-node"].iterationCount, 3);
  assertEquals(
    cp.graph.nodes["i-node"].failureReason,
    "iteration cap exhausted: review failed 3/3 times",
  );

  // node_reset with resetIterationCount:true — wipes the count.
  cp = transition(cp, {
    type: "node_reset",
    nodeId: "i-node",
    reason: "root cause fixed; reset count for clean slate",
    resetIterationCount: true,
  });

  assertEquals(cp.graph.nodes["i-node"].status, NodeStatus.PENDING);
  assertEquals(
    cp.graph.nodes["i-node"].iterationCount,
    0,
    "resetIterationCount:true must zero the counter",
  );
  assertEquals(cp.graph.nodes["i-node"].failureReason, undefined);
  assertEquals(cp.graph.nodes["i-node"].lastReviewVerdict, undefined);

  // Re-dispatch: set ACTIVE.
  cp = {
    ...cp,
    graph: {
      ...cp.graph,
      nodes: {
        ...cp.graph.nodes,
        "i-node": {
          ...cp.graph.nodes["i-node"],
          status: NodeStatus.ACTIVE,
        },
      },
    },
  };

  // Review passes on the fresh attempt.
  cp = transition(cp, {
    type: "review_passed",
    nodeId: "i-node",
    reviewVerdict: "PASS",
    reviewNotes: "Clean implementation after reset.",
  });

  assertEquals(cp.graph.nodes["i-node"].status, NodeStatus.DONE);
  assertEquals(
    cp.graph.nodes["i-node"].iterationCount,
    0,
    "iterationCount stays 0 — the recovery pass does not increment it",
  );
  assertEquals(cp.graph.nodes["i-node"].lastReviewVerdict, "PASS");
  assertEquals(cp.machineState, MachineState.COMPLETED);
});

// ---------------------------------------------------------------------------
// Scenario J — Cross-brain saga via mock checkpoints (no real second brain)
//
// Two repos: "main" and "secondary". Nodes are split across both:
//   main:      j-main-1 (ACTIVE), j-main-2 (ACTIVE)
//   secondary: j-sec-1  (ACTIVE), j-sec-2  (ACTIVE)
//
// Each checkpoint is independent (no shared state). We run the convergence
// loop on each independently:
//   - main:      j-main-1 review_failed × 2 then review_passed;
//                j-main-2 review_passed
//   - secondary: j-sec-1  review_failed × 1 then review_passed;
//                j-sec-2  review_failed × 3 → FAILED
//
// Assert:
//   - Per-repo iteration tracking is isolated (main failures do not increment
//     secondary node counts).
//   - saga_report aggregated across both repos reflects both repos' node outcomes.
// ---------------------------------------------------------------------------

Deno.test("convergence scenario J: cross-brain saga via mock checkpoints — per-repo isolation + aggregate saga_report", () => {
  const mainRepos: RepoMetadata[] = [
    { name: "main", root: "/fake/main", worktrees: [] },
  ];
  const secRepos: RepoMetadata[] = [
    { name: "secondary", root: "/fake/secondary", worktrees: [] },
  ];

  // ── Main checkpoint ──────────────────────────────────────────────────────
  const mainNodes = [
    makeNode("j-main-1", {
      status: NodeStatus.ACTIVE,
      maxIterations: 3,
      iterationCount: 0,
    }),
    makeNode("j-main-2", {
      status: NodeStatus.ACTIVE,
      maxIterations: 3,
      iterationCount: 0,
    }),
  ];
  const mainGraph = makeGraph(mainNodes);
  let cpMain = createCheckpoint(mainRepos, mainGraph);
  cpMain = transition(cpMain, { type: "plan_submitted" });
  cpMain = transition(cpMain, { type: "plan_finalized" });

  // j-main-1: fails twice then passes.
  cpMain = transition(cpMain, {
    type: "review_failed",
    nodeId: "j-main-1",
    reviewNotes: "Main round 1.",
  });
  cpMain = transition(cpMain, {
    type: "review_failed",
    nodeId: "j-main-1",
    reviewNotes: "Main round 2.",
  });
  cpMain = transition(cpMain, {
    type: "review_passed",
    nodeId: "j-main-1",
    reviewVerdict: "PASS",
  });

  // j-main-2: one-shot.
  cpMain = transition(cpMain, {
    type: "review_passed",
    nodeId: "j-main-2",
    reviewVerdict: "PASS",
  });

  assertEquals(cpMain.graph.nodes["j-main-1"].iterationCount, 2);
  assertEquals(cpMain.graph.nodes["j-main-1"].status, NodeStatus.DONE);
  assertEquals(cpMain.graph.nodes["j-main-2"].iterationCount, 0);
  assertEquals(cpMain.graph.nodes["j-main-2"].status, NodeStatus.DONE);

  // ── Secondary checkpoint ─────────────────────────────────────────────────
  const secNodes = [
    makeNode("j-sec-1", {
      status: NodeStatus.ACTIVE,
      maxIterations: 3,
      iterationCount: 0,
    }),
    makeNode("j-sec-2", {
      status: NodeStatus.ACTIVE,
      maxIterations: 3,
      iterationCount: 0,
    }),
  ];
  const secGraph = makeGraph(secNodes);
  let cpSec = createCheckpoint(secRepos, secGraph);
  cpSec = transition(cpSec, { type: "plan_submitted" });
  cpSec = transition(cpSec, { type: "plan_finalized" });

  // j-sec-1: fails once then passes.
  cpSec = transition(cpSec, {
    type: "review_failed",
    nodeId: "j-sec-1",
    reviewNotes: "Sec round 1.",
  });
  cpSec = transition(cpSec, {
    type: "review_passed",
    nodeId: "j-sec-1",
    reviewVerdict: "PASS",
  });

  // j-sec-2: fails 3× → FAILED.
  cpSec = transition(cpSec, { type: "review_failed", nodeId: "j-sec-2" });
  cpSec = transition(cpSec, { type: "review_failed", nodeId: "j-sec-2" });
  cpSec = transition(cpSec, {
    type: "review_failed",
    nodeId: "j-sec-2",
    reviewNotes: "Cap hit on secondary.",
  });

  assertEquals(cpSec.graph.nodes["j-sec-1"].iterationCount, 1);
  assertEquals(cpSec.graph.nodes["j-sec-1"].status, NodeStatus.DONE);
  assertEquals(cpSec.graph.nodes["j-sec-2"].status, NodeStatus.FAILED);

  // ── Per-repo isolation: main failures did NOT affect secondary ────────────
  // j-sec-1 saw only its own review_failed (1 — not 2 from main's j-main-1).
  assertEquals(cpSec.graph.nodes["j-sec-1"].iterationCount, 1);
  // j-main-1 saw only its own failures (2 — not 1 from secondary's j-sec-1).
  assertEquals(cpMain.graph.nodes["j-main-1"].iterationCount, 2);

  // ── Aggregate saga_report across both repos ───────────────────────────────
  const reportMain = buildSagaReport(cpMain);
  const reportSec = buildSagaReport(cpSec);

  // Main: 2 nodes — j-main-1 converged (iters>0), j-main-2 one-shot.
  assertEquals(reportMain.totalNodes, 2);
  assertEquals(reportMain.converged, 1);
  assertEquals(reportMain.oneShot, 1);
  assertEquals(reportMain.failed, 0);

  // Secondary: 2 nodes — j-sec-1 converged (iters>0), j-sec-2 failed.
  assertEquals(reportSec.totalNodes, 2);
  assertEquals(reportSec.converged, 1);
  assertEquals(reportSec.oneShot, 0);
  assertEquals(reportSec.failed, 1);
  assertEquals(reportSec.escalations.length, 1);
  assertEquals(reportSec.escalations[0].nodeId, "j-sec-2");

  // Aggregate: combine both report totals (as the lead would do cross-brain).
  const aggregateTotalNodes = reportMain.totalNodes + reportSec.totalNodes;
  const aggregateFailed = reportMain.failed + reportSec.failed;
  const aggregateConverged = reportMain.converged + reportSec.converged;
  const aggregateOneShot = reportMain.oneShot + reportSec.oneShot;

  assertEquals(aggregateTotalNodes, 4);
  assertEquals(aggregateFailed, 1);
  assertEquals(aggregateConverged, 2);
  assertEquals(aggregateOneShot, 1);
});
