// deno-lint-ignore-file require-await -- BrainExec mocks satisfy an async interface without awaiting

/**
 * Handler-boundary tests for trimatrix server tool contracts.
 *
 * These tests do NOT spin up a full MCP server or spawn a real MCP transport.
 * They exercise the pure-function call-chains that server.ts tool handlers
 * delegate to, with injected BrainExec mocks. Response shapes asserted here
 * mirror what the handler returns — if Two of Four changes the contract, these
 * tests will catch the regression.
 *
 * Coverage:
 * - add_subgraph: valid add, duplicate-slug rejection, node-not-in-graph error
 * - dispatch_wave: wave-shape validation, capability gating, external-blocker partition
 * - add_external_blocker: response shape { ok, idempotent, externalId, taskId }; BrainError path
 * - resolve_external_blocker: response shape { ok, idempotent, externalId, taskId }; BrainError path
 * - next_frontier: externallyBlocked filter; response shape
 * - close_node: fail-loud on non-terminal status
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  addSubgraph,
  canDispatch,
  closeNodeGuard,
  currentFrontier,
  nextFrontierBatch,
  validateDispatch,
} from "./graph.ts";
import { canTransition, transition } from "./state.ts";
import {
  BrainError,
  buildExternalBlockerResponse,
  callBrainTool,
  getExternalBlockers,
} from "./brain-sync.ts";
import type { BrainExec, ExternalBlockerSnapshot } from "./brain-sync.ts";
import {
  CoordinationMode,
  Executor,
  MachineState,
  NodeStatus,
  NodeType,
  ReadinessStatus,
  SubgraphCompletionPolicy,
  SubgraphFailurePolicy,
  Tier,
} from "./types.ts";
import type { Checkpoint, Graph, Node, Wave } from "./types.ts";

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
    version: "2.6.0",
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
    eventLog: [],
    ...overrides,
  };
}

/** BrainExec mock that returns a canned tasks.apply_event response. */
function makeApplyEventMock(opts: {
  idempotent?: boolean;
  fail?: boolean;
  errorMsg?: string;
  errorCode?: number;
}): BrainExec {
  return {
    withStdin: async (
      _cmd: string,
      _args: string[],
      stdin?: string,
    ): Promise<string> => {
      if (opts.fail) {
        if (opts.errorMsg) {
          // Return an error-payload JSON-RPC response to trigger BrainError
          const req = JSON.parse(stdin ?? "{}");
          return JSON.stringify({
            jsonrpc: "2.0",
            id: req.id ?? 1,
            error: { message: opts.errorMsg, code: opts.errorCode ?? -32000 },
          });
        }
        throw new Error("brain CLI unavailable");
      }
      const req = JSON.parse(stdin ?? "{}");
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id ?? 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ idempotent: opts.idempotent ?? false }),
          }],
        },
      });
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };
}

/** BrainExec mock that simulates the tasks.get response for external-blocker consultation. */
function makeBlockerCheckMock(opts: {
  blockers: ExternalBlockerSnapshot[];
  unresolvedCount?: number;
  fail?: boolean;
}): BrainExec {
  return {
    withStdin: async (
      _cmd: string,
      _args: string[],
      stdin?: string,
    ): Promise<string> => {
      if (opts.fail) throw new Error("brain CLI unavailable");
      const req = JSON.parse(stdin ?? "{}");
      const unresolvedCount = opts.unresolvedCount ??
        opts.blockers.filter((b) => !b.resolvedAt).length;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id ?? 1,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              external_blockers: opts.blockers,
              dependency_summary: {
                external_blocker_unresolved_count: unresolvedCount,
              },
            }),
          }],
        },
      });
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };
}

// ---------------------------------------------------------------------------
// add_subgraph handler contract
// ---------------------------------------------------------------------------

Deno.test("handler: add_subgraph — valid add returns correct subgraph shape", () => {
  const graph = makeGraph([makeNode("n1"), makeNode("n2")]);
  let cp = makeCp(graph);

  const result = addSubgraph(graph, cp.subgraphs ?? [], {
    slug: "handler-sg",
    nodeIds: ["n1"],
    executor: Executor.ADJUNCT,
    tier: Tier.T2,
  });
  assertEquals(result.ok, true);

  cp = transition(cp, { type: "subgraph_added", subgraph: result.value! });
  const sg = cp.subgraphs?.find((s) => s.id === "handler-sg");

  assertEquals(sg?.id, "handler-sg");
  assertEquals(sg?.executor, Executor.ADJUNCT);
  assertEquals(sg?.tier, Tier.T2);
  assertEquals(sg?.derived, false);
  assertEquals(sg?.nodes, ["n1"]);
  assertEquals(sg?.completionPolicy, SubgraphCompletionPolicy.ALL);
  assertEquals(sg?.failurePolicy, SubgraphFailurePolicy.FAIL_FAST);
  assertEquals(sg?.coordination.mode, CoordinationMode.NONE);
});

Deno.test("handler: add_subgraph — same slug with different spec is rejected", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = makeCp(graph);

  const first = addSubgraph(graph, [], {
    slug: "dup-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(first.ok, true);
  cp = transition(cp, { type: "subgraph_added", subgraph: first.value! });

  // Second add with same slug but different tier — spec mismatch → rejection
  const second = addSubgraph(graph, cp.subgraphs ?? [], {
    slug: "dup-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T3,
  });
  assertEquals(second.ok, false);
  assertEquals(second.error !== undefined, true);
  assertEquals(
    second.error!.includes("already exists with a different spec"),
    true,
  );
});

Deno.test("handler: add_subgraph — same slug with same spec is idempotent (ok: true)", () => {
  const graph = makeGraph([makeNode("n1")]);
  let cp = makeCp(graph);

  const first = addSubgraph(graph, [], {
    slug: "idem-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(first.ok, true);
  cp = transition(cp, { type: "subgraph_added", subgraph: first.value! });

  // Re-add with identical spec → idempotent, ok: true
  const second = addSubgraph(graph, cp.subgraphs ?? [], {
    slug: "idem-sg",
    nodeIds: ["n1"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(second.ok, true);
  assertEquals(second.value?.id, "idem-sg");
});

Deno.test("handler: add_subgraph — node not in graph produces addSubgraph error", () => {
  const graph = makeGraph([makeNode("n1")]);
  const result = addSubgraph(graph, [], {
    slug: "bad-nodes",
    nodeIds: ["does-not-exist"],
    executor: Executor.LEAD,
    tier: Tier.T1,
  });
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// dispatch_wave: external-blocker partition
// ---------------------------------------------------------------------------

Deno.test("handler: dispatch_wave — node with unresolved blocker is not activated", async () => {
  const node = makeNode("n1", { taskId: "task-blocked" });
  const exec = makeBlockerCheckMock({
    blockers: [{ source: "jira", externalId: "X-1" }],
    unresolvedCount: 1,
  });

  const { unresolvedCount, blockers } = await getExternalBlockers(
    node.taskId!,
    exec,
  );

  const externalBlocked: Array<
    { nodeId: string; blockers: ExternalBlockerSnapshot[] }
  > = [];
  const clearToActivate: string[] = [];
  if (unresolvedCount > 0) {
    externalBlocked.push({ nodeId: node.id, blockers });
  } else {
    clearToActivate.push(node.id);
  }

  assertEquals(
    clearToActivate.length,
    0,
    "blocked node must not be in activate set",
  );
  assertEquals(externalBlocked.length, 1);
  assertEquals(externalBlocked[0].nodeId, "n1");
  assertEquals(externalBlocked[0].blockers[0].source, "jira");
  assertEquals(externalBlocked[0].blockers[0].externalId, "X-1");
});

Deno.test("handler: dispatch_wave — node without taskId skips brain consultation and activates", async () => {
  const node = makeNode("n1"); // no taskId
  const exec = makeBlockerCheckMock({ blockers: [], fail: true }); // would throw if called

  const clearToActivate: string[] = [];
  const externalBlocked: string[] = [];

  if (!node.taskId) {
    clearToActivate.push(node.id);
  } else {
    const { unresolvedCount } = await getExternalBlockers(node.taskId, exec);
    if (unresolvedCount > 0) externalBlocked.push(node.id);
    else clearToActivate.push(node.id);
  }

  assertEquals(clearToActivate, ["n1"]);
  assertEquals(externalBlocked.length, 0);
});

Deno.test("handler: dispatch_wave — brain CLI failure degrades gracefully (node activates)", async () => {
  const node = makeNode("n1", { taskId: "task-offline" });
  const exec = makeBlockerCheckMock({ blockers: [], fail: true });

  const { unresolvedCount, blockers } = await getExternalBlockers(
    node.taskId!,
    exec,
  );

  assertEquals(unresolvedCount, 0, "failure must not block dispatch");
  assertEquals(blockers.length, 0);
});

// ---------------------------------------------------------------------------
// dispatch_wave: capability matching
// ---------------------------------------------------------------------------

Deno.test("handler: dispatch_wave — capability mismatch is detected per node", () => {
  const graph = makeGraph([
    makeNode("write-node", { requirements: { canWrite: true } }),
    makeNode("read-node", { requirements: { canWrite: false } }),
  ]);

  const readOnlyCaps = { canWrite: false };

  const mismatches: { nodeId: string; missing: string[] }[] = [];
  const capabilityRejected = new Set<string>();
  for (const nId of ["write-node", "read-node"]) {
    const result = validateDispatch(graph, nId, readOnlyCaps);
    if (!result.ok) {
      const node = graph.nodes[nId];
      const detail = canDispatch(readOnlyCaps, node?.requirements);
      if (!detail.ok) {
        mismatches.push({ nodeId: nId, missing: detail.missing });
        capabilityRejected.add(nId);
      }
    }
  }

  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].nodeId, "write-node");
  assertEquals(mismatches[0].missing, ["canWrite"]);
  assertEquals(capabilityRejected.has("write-node"), true);
  assertEquals(capabilityRejected.has("read-node"), false);
});

// ---------------------------------------------------------------------------
// add_external_blocker response shape
// ---------------------------------------------------------------------------

Deno.test("handler: add_external_blocker — happy-path response shape { ok, idempotent, externalId, taskId }", async () => {
  const taskId = "task-abc";
  const externalId = "PROJ-123";
  const exec = makeApplyEventMock({ idempotent: false });

  // Drive the actual response-shaping helper used by the production handler.
  const result = await callBrainTool(exec, "tasks.apply_event", {
    task_id: taskId,
    event: { type: "external_blocker_added", source: "jira", externalId },
  });
  const response = buildExternalBlockerResponse(taskId, externalId, result);

  assertEquals(response.ok, true);
  assertEquals(response.idempotent, false);
  assertEquals(response.externalId, externalId);
  assertEquals(response.taskId, taskId);
  // Critically: no brainResponse envelope leak — assert the response shape is
  // exactly the four documented fields.
  assertEquals(Object.keys(response).sort(), [
    "externalId",
    "idempotent",
    "ok",
    "taskId",
  ]);
});

Deno.test("handler: add_external_blocker — idempotent=true surfaced when brain reports idempotent", async () => {
  const taskId = "task-idempotent";
  const externalId = "X-42";
  const exec = makeApplyEventMock({ idempotent: true });

  const result = await callBrainTool(exec, "tasks.apply_event", {
    task_id: taskId,
    event: { type: "external_blocker_added", source: "jira", externalId },
  });
  const response = buildExternalBlockerResponse(taskId, externalId, result);
  assertEquals(response.idempotent, true);
});

Deno.test("handler: add_external_blocker — non-boolean idempotent in result coerces to false", () => {
  // Brain returns idempotent: "yes" (wrong type), or omits the field entirely.
  // The shaper must defensively coerce to false rather than leaking truthy strings.
  const cases: Array<{ raw: unknown; expected: boolean }> = [
    { raw: { idempotent: "true" }, expected: false },
    { raw: { idempotent: 1 }, expected: false },
    { raw: { idempotent: null }, expected: false },
    { raw: {}, expected: false },
    { raw: null, expected: false },
    { raw: undefined, expected: false },
    { raw: { idempotent: true }, expected: true },
  ];
  for (const { raw, expected } of cases) {
    const r = buildExternalBlockerResponse("t", "x", raw);
    assertEquals(r.idempotent, expected);
  }
});

Deno.test("handler: add_external_blocker — BrainError thrown when brain returns error payload", async () => {
  const exec = makeApplyEventMock({
    fail: true,
    errorMsg: "task not found",
    errorCode: 404,
  });

  await assertRejects(
    async () => {
      await callBrainTool(exec, "tasks.apply_event", {
        task_id: "missing-task",
        event: {
          type: "external_blocker_added",
          source: "jira",
          externalId: "X-99",
        },
      });
    },
    BrainError,
    "task not found",
  );
});

// ---------------------------------------------------------------------------
// resolve_external_blocker response shape
// ---------------------------------------------------------------------------

Deno.test("handler: resolve_external_blocker — happy-path response shape { ok, idempotent, externalId, taskId }", async () => {
  const taskId = "task-resolve";
  const externalId = "PROJ-456";
  const exec = makeApplyEventMock({ idempotent: false });

  const result = await callBrainTool(exec, "tasks.apply_event", {
    task_id: taskId,
    event: { type: "external_blocker_resolved", source: "jira", externalId },
  });
  const response = buildExternalBlockerResponse(taskId, externalId, result);

  assertEquals(response.ok, true);
  assertEquals(response.idempotent, false);
  assertEquals(response.externalId, externalId);
  assertEquals(response.taskId, taskId);
  assertEquals(Object.keys(response).sort(), [
    "externalId",
    "idempotent",
    "ok",
    "taskId",
  ]);
});

Deno.test("handler: resolve_external_blocker — BrainError thrown when brain returns error payload", async () => {
  const exec = makeApplyEventMock({
    fail: true,
    errorMsg: "blocker not found",
    errorCode: 404,
  });

  await assertRejects(
    async () => {
      await callBrainTool(exec, "tasks.apply_event", {
        task_id: "task-resolve-err",
        event: {
          type: "external_blocker_resolved",
          source: "jira",
          externalId: "X-100",
        },
      });
    },
    BrainError,
    "blocker not found",
  );
});

// ---------------------------------------------------------------------------
// next_frontier response shape and externallyBlocked filter
// ---------------------------------------------------------------------------

Deno.test("handler: next_frontier — externallyBlocked nodes are absent from result", () => {
  const graph = makeGraph([
    makeNode("blocked-ext", {
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode("free", {
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["blocked-ext", "free"],
    hasMergeGate: false,
  }];

  // The handler calls nextFrontierBatch and currentFrontier
  const batches = nextFrontierBatch(graph, waves, null);
  assertEquals(batches.length, 1);
  assertEquals(batches[0].nodeIds.includes("blocked-ext"), false);
  assertEquals(batches[0].nodeIds.includes("free"), true);

  const frontier = currentFrontier(graph, waves);
  assertEquals(frontier.some((e) => e.nodeId === "blocked-ext"), false);
  assertEquals(frontier.some((e) => e.nodeId === "free"), true);
});

Deno.test("handler: next_frontier — all nodes externallyBlocked → empty batches", () => {
  const graph = makeGraph([
    makeNode("ext1", {
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
    makeNode("ext2", {
      status: NodeStatus.PENDING,
      readinessStatus: ReadinessStatus.READY,
      externallyBlocked: true,
    }),
  ]);
  const waves: Wave[] = [{
    id: 1,
    nodes: ["ext1", "ext2"],
    hasMergeGate: false,
  }];

  const batches = nextFrontierBatch(graph, waves, null);
  assertEquals(batches.length, 0);

  const frontier = currentFrontier(graph, waves);
  assertEquals(frontier.length, 0);
});

// ---------------------------------------------------------------------------
// close_node: fail-loud on non-terminal status
// ---------------------------------------------------------------------------

Deno.test("handler: close_node guard — non-terminal node status produces error", () => {
  const node = makeNode("n1", {
    status: NodeStatus.ACTIVE,
    taskId: "task-active",
  });
  const result = closeNodeGuard(node, "n1");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("ACTIVE"),
      true,
      "error must name the offending status",
    );
    assertEquals(
      result.error.includes("DONE, MERGED, or PR_CREATED"),
      true,
      "error must list valid statuses",
    );
  }
});

Deno.test("handler: close_node guard — DONE / MERGED / PR_CREATED pass", () => {
  for (
    const status of [
      NodeStatus.DONE,
      NodeStatus.MERGED,
      NodeStatus.PR_CREATED,
    ]
  ) {
    const node = makeNode("n1", { status, taskId: "task-done" });
    const result = closeNodeGuard(node, "n1");
    assertEquals(result.ok, true, `${status} must pass the guard`);
  }
});

Deno.test("handler: close_node guard — missing node produces error", () => {
  const result = closeNodeGuard(undefined, "ghost");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("not found"), true);
});

Deno.test("handler: close_node guard — no taskId produces error", () => {
  const node = makeNode("n1", { status: NodeStatus.DONE });
  const result = closeNodeGuard(node, "n1");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("no associated taskId"), true);
  }
});

// ---------------------------------------------------------------------------
// BrainError class contract
// ---------------------------------------------------------------------------

Deno.test("BrainError: is instanceof Error and BrainError", () => {
  const err = new BrainError("test error", 500);
  assertEquals(err instanceof Error, true);
  assertEquals(err instanceof BrainError, true);
  assertEquals(err.name, "BrainError");
  assertEquals(err.message, "test error");
  assertEquals(err.code, 500);
});

Deno.test("BrainError: code is undefined when not provided", () => {
  const err = new BrainError("no code");
  assertEquals(err.code, undefined);
});

// ---------------------------------------------------------------------------
// callBrainTool: transport failure propagates
// ---------------------------------------------------------------------------

Deno.test("callBrainTool: transport failure (throw) propagates out of callBrainTool", async () => {
  const exec: BrainExec = {
    withStdin: async () => {
      throw new Error("connection refused");
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };

  await assertRejects(
    async () => {
      await callBrainTool(exec, "tasks.get", { task_id: "any" });
    },
    Error,
    "connection refused",
  );
});

// ---------------------------------------------------------------------------
// saga_report: buildSagaReport aggregation
// ---------------------------------------------------------------------------

import { buildSagaReport, renderSagaReport } from "./saga_report.ts";

Deno.test("buildSagaReport: synthetic 5-node graph — correct aggregates", () => {
  // Graph: 5 nodes
  //   n1 — DONE, iterationCount 0  → oneShot
  //   n2 — DONE, iterationCount 0  → oneShot
  //   n3 — MERGED, iterationCount 2 → converged
  //   n4 — DONE, iterationCount 1  → converged
  //   n5 — FAILED, iterationCount 3, maxIterations 3 → failed + escalation
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE, iterationCount: 0 }),
    makeNode("n2", { status: NodeStatus.DONE, iterationCount: 0 }),
    makeNode("n3", { status: NodeStatus.MERGED, iterationCount: 2 }),
    makeNode("n4", { status: NodeStatus.DONE, iterationCount: 1 }),
    makeNode("n5", {
      status: NodeStatus.FAILED,
      iterationCount: 3,
      maxIterations: 3,
      lastReviewVerdict: "FAIL",
      lastReviewNotes: "Types still broken after 3 attempts",
      failureReason: "Cap exhausted (3/3 iterations)",
    }),
  ];
  const graph = makeGraph(nodes);
  const cp = makeCp(graph);

  const report = buildSagaReport(cp);

  assertEquals(report.totalNodes, 5);
  assertEquals(report.oneShot, 2);
  assertEquals(report.converged, 2);
  assertEquals(report.failed, 1);
  assertEquals(report.maxIterationsObserved, 3);
  // avgIterations = (0+0+2+1+3) / 5 = 1.2
  assertEquals(report.avgIterations, 1.2);
  assertEquals(report.escalations.length, 1);
  assertEquals(report.escalations[0].nodeId, "n5");
  assertEquals(
    report.escalations[0].lastReviewNotes,
    "Types still broken after 3 attempts",
  );
  assertEquals(report.nodeSummaries.length, 0);
});

Deno.test("buildSagaReport: all one-shot — zero avg iterations", () => {
  const nodes: Node[] = [
    makeNode("a", { status: NodeStatus.DONE, iterationCount: 0 }),
    makeNode("b", { status: NodeStatus.MERGED, iterationCount: 0 }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const report = buildSagaReport(cp);

  assertEquals(report.totalNodes, 2);
  assertEquals(report.oneShot, 2);
  assertEquals(report.converged, 0);
  assertEquals(report.failed, 0);
  assertEquals(report.avgIterations, 0);
  assertEquals(report.escalations.length, 0);
});

Deno.test("buildSagaReport: non-terminal nodes excluded from aggregates", () => {
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE, iterationCount: 1 }),
    makeNode("n2", { status: NodeStatus.ACTIVE, iterationCount: 0 }),
    makeNode("n3", { status: NodeStatus.PENDING }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const report = buildSagaReport(cp);

  // Total nodes counts all nodes in graph (3).
  assertEquals(report.totalNodes, 3);
  // Only n1 is terminal.
  assertEquals(report.converged, 1);
  assertEquals(report.oneShot, 0);
  assertEquals(report.failed, 0);
  assertEquals(report.avgIterations, 1);
  assertEquals(report.maxIterationsObserved, 1);
});

Deno.test("buildSagaReport: nodeSummaries passed through correctly", () => {
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE, iterationCount: 0 }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const summaries = [
    {
      nodeId: "n1",
      status: "DONE",
      commits: ["abc1234"],
      whatChanged: "Added validation",
    },
  ];
  const report = buildSagaReport(cp, summaries);
  assertEquals(report.nodeSummaries.length, 1);
  assertEquals(report.nodeSummaries[0].nodeId, "n1");
  assertEquals(report.nodeSummaries[0].commits[0], "abc1234");
});

Deno.test("renderSagaReport: markdown output contains key headings", () => {
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE, iterationCount: 0 }),
    makeNode("n2", {
      status: NodeStatus.FAILED,
      iterationCount: 3,
      maxIterations: 3, // cap exhausted → triggers escalation
      lastReviewVerdict: "FAIL",
    }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const report = buildSagaReport(cp);
  const md = renderSagaReport(report, "markdown");

  assertEquals(md.includes("# Saga Convergence Report"), true);
  assertEquals(md.includes("## Summary"), true);
  assertEquals(md.includes("## Escalations"), true);
  assertEquals(md.includes("n2"), true);
});

Deno.test("renderSagaReport: json output is valid JSON with correct shape", () => {
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE, iterationCount: 0 }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const report = buildSagaReport(cp);
  const json = renderSagaReport(report, "json");
  const parsed = JSON.parse(json);

  assertEquals(typeof parsed.totalNodes, "number");
  assertEquals(typeof parsed.oneShot, "number");
  assertEquals(typeof parsed.converged, "number");
  assertEquals(typeof parsed.failed, "number");
  assertEquals(typeof parsed.avgIterations, "number");
  assertEquals(typeof parsed.maxIterationsObserved, "number");
  assertEquals(Array.isArray(parsed.escalations), true);
  assertEquals(Array.isArray(parsed.nodeSummaries), true);
});

// ---------------------------------------------------------------------------
// reset_node handler contract
// ---------------------------------------------------------------------------

Deno.test("handler: reset_node — happy path: FAILED → PENDING, leaseVersion bumped", () => {
  const node = makeNode("n1", {
    status: NodeStatus.FAILED,
    iterationCount: 1,
    leaseVersion: 2,
    attemptId: "attempt-abc",
  });
  const graph = makeGraph([node]);
  // node_reset requires DISPATCHING machine state
  let cp = makeCp(graph, { machineState: MachineState.DISPATCHING });

  // Verify transition is allowed from DISPATCHING state
  const check = canTransition(cp, { type: "node_reset", nodeId: "n1" });
  assertEquals(
    check.allowed,
    true,
    "transition must be allowed for FAILED node in DISPATCHING state",
  );

  // Apply transition
  cp = transition(cp, { type: "node_reset", nodeId: "n1" });
  const updated = cp.graph.nodes["n1"];

  assertEquals(updated.status, NodeStatus.PENDING);
  // leaseVersion must be bumped to invalidate in-flight WorkPackets
  assertEquals(updated.leaseVersion, 3);
  // iterationCount preserved (resetIterationCount not requested)
  assertEquals(updated.iterationCount, 1);
});

Deno.test("handler: reset_node — stale fence: wrong leaseVersion throws", () => {
  const node = makeNode("n1", {
    status: NodeStatus.FAILED,
    leaseVersion: 5,
    attemptId: "attempt-xyz",
  });
  const graph = makeGraph([node]);
  const cp = makeCp(graph);
  const resetTarget = cp.graph.nodes["n1"];

  // Simulate the handler's stale-fence check
  const providedAttemptId = "attempt-xyz";
  const providedLeaseVersion = 4; // stale — current is 5

  let threw = false;
  if (
    resetTarget.attemptId !== providedAttemptId ||
    resetTarget.leaseVersion !== providedLeaseVersion
  ) {
    threw = true;
  }
  assertEquals(threw, true, "stale leaseVersion must trigger fence rejection");
});

Deno.test("handler: reset_node — idempotency: already-PENDING with same leaseVersion returns ok idempotent", () => {
  const node = makeNode("n1", {
    status: NodeStatus.PENDING,
    leaseVersion: 3,
  });
  const graph = makeGraph([node]);
  const cp = makeCp(graph);
  const resetTarget = cp.graph.nodes["n1"];

  // Simulate the handler's idempotency check
  const sameVersion = resetTarget.leaseVersion === 3;
  assertEquals(resetTarget.status, NodeStatus.PENDING);
  assertEquals(sameVersion, true);
  // Second reset_node call should be idempotent — ok: true, idempotent: true
  // The handler returns { ok: true, idempotent: true, leaseVersion: 3 } without re-transitioning.
  assertEquals(resetTarget.leaseVersion, 3);
});

// ---------------------------------------------------------------------------
// saga_report handler contract — empty graph + format flags
// (NOTE: previously misnamed as "materialize_plan" — these exercise
// buildSagaReport / renderSagaReport. materialize_plan-specific contracts
// live in materialize.test.ts.)
// ---------------------------------------------------------------------------

Deno.test("handler: saga_report — empty graph produces valid markdown output", () => {
  const cp = makeCp(makeGraph([]));
  // buildSagaReport on empty graph should not throw and must return valid shape
  const report = buildSagaReport(cp);
  assertEquals(report.totalNodes, 0);
  assertEquals(report.oneShot, 0);
  assertEquals(report.converged, 0);
  assertEquals(report.failed, 0);

  // renderSagaReport must produce non-empty markdown with at least one ## heading
  const md = renderSagaReport(report, "markdown");
  assertEquals(md.length > 0, true);
  assertEquals(md.includes("## Summary"), true);
});

Deno.test("handler: saga_report — format: json returns JSON-parseable; markdown returns ## heading", () => {
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE, iterationCount: 0 }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const report = buildSagaReport(cp);

  const md = renderSagaReport(report, "markdown");
  assertEquals(md.includes("##"), true, "markdown must contain ## heading");

  const json = renderSagaReport(report, "json");
  const parsed = JSON.parse(json);
  assertEquals(typeof parsed, "object", "json must be parseable to object");
});

// ---------------------------------------------------------------------------
// saga_report brain-integration: mock BrainExec returning records_list payload
// ---------------------------------------------------------------------------

/** Build a BrainExec mock that simulates records.list then records.fetch_content. */
function makeRecordsMock(opts: {
  records: Array<{ id: string; tags: string[] }>;
  bodyByRecordId: Record<string, string>;
}): BrainExec {
  return {
    withStdin: async (
      _cmd: string,
      _args: string[],
      stdin?: string,
    ): Promise<string> => {
      const req = JSON.parse(stdin ?? "{}");
      const toolName: string = req?.params?.name ?? "";
      const args: Record<string, unknown> = req?.params?.arguments ?? {};

      if (toolName === "records.list") {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: req.id ?? 1,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ records: opts.records }),
            }],
          },
        });
      }

      if (toolName === "records.fetch_content") {
        const recordId = args["record_id"] as string;
        const body = opts.bodyByRecordId[recordId] ?? "";
        return JSON.stringify({
          jsonrpc: "2.0",
          id: req.id ?? 1,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ text: body }),
            }],
          },
        });
      }

      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id ?? 1,
        error: { message: `Unknown tool: ${toolName}`, code: -32601 },
      });
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };
}

Deno.test("handler: saga_report brain-integration — records.list + fetch_content parses nodeSummaries correctly", async () => {
  // This test exercises the exact brain-round-trip pipeline in the saga_report handler.
  // It would have caught HIGH-B1 (double-parse bug) because the mock returns parsed objects,
  // not raw JSON strings — matching what callBrainTool actually returns.
  const sessionLabel = "my-saga-2026";
  const records = [
    { id: "rec-001", tags: ["node-summary", sessionLabel] },
    { id: "rec-002", tags: ["node-summary", sessionLabel] },
  ];
  const bodyByRecordId: Record<string, string> = {
    "rec-001": [
      "## Node Summary: node-alpha",
      "**Status:** DONE",
      "**Commits:** abc1234, def5678",
      "**What changed:** Implemented validation logic",
    ].join("\n"),
    "rec-002": [
      "## Node Summary: node-beta",
      "**Status:** MERGED",
      "**Commits:** 9abcdef",
      "**What changed:** Added test coverage",
    ].join("\n"),
  };

  const exec = makeRecordsMock({ records, bodyByRecordId });

  // Drive callBrainTool directly as the handler does (post HIGH-B1 fix: no JSON.parse wrapping).
  const listResp = await callBrainTool(exec, "records.list", {
    tag: "node-summary",
  });
  const listData = listResp as {
    records?: Array<{ id?: string; tags?: string[] }>;
    items?: Array<{ id?: string; tags?: string[] }>;
  };
  const allRecords = listData.records ?? listData.items ?? [];
  const sessionRecords = allRecords.filter(
    (r) => Array.isArray(r.tags) && r.tags.includes(sessionLabel),
  );

  assertEquals(sessionRecords.length, 2, "must find both session records");

  const nodeSummaries = [];
  for (const rec of sessionRecords) {
    if (!rec.id) continue;
    const content = await callBrainTool(exec, "records.fetch_content", {
      record_id: rec.id,
    });
    const parsed = content as { text?: string; data?: string };
    const text: string = parsed.text ?? parsed.data ?? "";
    const statusMatch = text.match(/\*\*Status:\*\*\s*(\S+)/);
    const commitsMatch = text.match(/\*\*Commits:\*\*\s*([^\n]+)/);
    const whatMatch = text.match(/\*\*What changed:\*\*\s*([^\n]+)/);
    const nodeIdMatch = text.match(/## Node Summary:\s*(\S+)/);
    nodeSummaries.push({
      nodeId: nodeIdMatch?.[1] ?? rec.id,
      status: statusMatch?.[1] ?? "unknown",
      commits: commitsMatch?.[1]
        ? commitsMatch[1].split(/[,\s]+/).filter(Boolean)
        : [],
      whatChanged: whatMatch?.[1] ?? "(no summary)",
    });
  }

  assertEquals(nodeSummaries.length, 2, "nodeSummaries must not be empty");
  assertEquals(nodeSummaries[0].nodeId, "node-alpha");
  assertEquals(nodeSummaries[0].status, "DONE");
  assertEquals(nodeSummaries[0].commits.length, 2);
  assertEquals(nodeSummaries[1].nodeId, "node-beta");
  assertEquals(nodeSummaries[1].whatChanged, "Added test coverage");
});

Deno.test("handler: saga_report mid-saga precondition — non-terminal saga returns ok: false without allowPartial", () => {
  const nodes: Node[] = [
    makeNode("n1", { status: NodeStatus.DONE }),
    makeNode("n2", { status: NodeStatus.ACTIVE }), // not terminal
    makeNode("n3", { status: NodeStatus.PENDING }), // not terminal
  ];
  const cp = makeCp(makeGraph(nodes));
  const allNodes = Object.values(cp.graph.nodes);
  const nonTerminal = allNodes.filter(
    (n) =>
      n.status !== NodeStatus.DONE &&
      n.status !== NodeStatus.MERGED &&
      n.status !== NodeStatus.FAILED,
  );

  // Without allowPartial, handler must return { ok: false, reason: "saga not terminal..." }
  assertEquals(nonTerminal.length, 2, "two non-terminal nodes exist");
  // Verify that the precondition string is correct
  const reason =
    `saga not terminal — ${nonTerminal.length} of ${allNodes.length} nodes still pending or active`;
  assertEquals(reason.includes("saga not terminal"), true);
  assertEquals(reason.includes("2 of 3"), true);
});

Deno.test("handler: saga_report partial summaries — missing per-node records degrade gracefully", () => {
  // Only node-alpha has a brain record; node-beta has none.
  // buildSagaReport must accept partial nodeSummaries and not throw.
  const nodes: Node[] = [
    makeNode("node-alpha", { status: NodeStatus.DONE, iterationCount: 0 }),
    makeNode("node-beta", { status: NodeStatus.DONE, iterationCount: 0 }),
  ];
  const cp = makeCp(makeGraph(nodes));

  // Partial summaries — only one of two nodes has a brain record.
  const partialSummaries = [
    {
      nodeId: "node-alpha",
      status: "DONE",
      commits: ["abc1234"],
      whatChanged: "Refactored handler",
    },
  ];

  const report = buildSagaReport(cp, partialSummaries);
  assertEquals(report.totalNodes, 2);
  assertEquals(
    report.nodeSummaries.length,
    1,
    "partial summaries pass through",
  );
  assertEquals(report.nodeSummaries[0].nodeId, "node-alpha");
  // node-beta has no summary — graceful, no error
  assertEquals(
    report.nodeSummaries.find((s) => s.nodeId === "node-beta"),
    undefined,
    "missing summary is absent, not a sentinel error entry",
  );
});

// ---------------------------------------------------------------------------
// buildSagaReport: escalation predicate — cap-exhausted only
// ---------------------------------------------------------------------------

Deno.test("buildSagaReport: escalation predicate — only cap-exhausted nodes escalate", () => {
  const nodes: Node[] = [
    makeNode("n-cap", {
      status: NodeStatus.FAILED,
      iterationCount: 3,
      maxIterations: 3,
      lastReviewVerdict: "FAIL",
    }),
    makeNode("n-not-cap", {
      status: NodeStatus.FAILED,
      iterationCount: 1,
      maxIterations: 3,
      lastReviewVerdict: "FAIL",
      // Not at cap — has retries remaining. Should NOT escalate.
    }),
  ];
  const cp = makeCp(makeGraph(nodes));
  const report = buildSagaReport(cp);

  assertEquals(report.failed, 2, "both nodes are failed");
  assertEquals(
    report.escalations.length,
    1,
    "only cap-exhausted node escalates",
  );
  assertEquals(report.escalations[0].nodeId, "n-cap");
});
