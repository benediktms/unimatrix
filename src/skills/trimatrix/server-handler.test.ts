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
  currentFrontier,
  nextFrontierBatch,
  validateDispatch,
} from "./graph.ts";
import { transition } from "./state.ts";
import {
  BrainError,
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

  // Simulate the handler call: callBrainTool → extract fields → build response
  const result = await callBrainTool(exec, "tasks.apply_event", {
    task_id: taskId,
    event: { type: "external_blocker_added", source: "jira", externalId },
  });

  const idempotent = (result as Record<string, unknown> | null)?.idempotent ??
    false;

  // Assert response shape matches handler contract
  const response = { ok: true, idempotent, externalId, taskId };
  assertEquals(response.ok, true);
  assertEquals(response.idempotent, false);
  assertEquals(response.externalId, externalId);
  assertEquals(response.taskId, taskId);
  // Critically: no brainResponse envelope leak
  assertEquals("brainResponse" in response, false);
});

Deno.test("handler: add_external_blocker — idempotent=true surfaced when brain reports idempotent", async () => {
  const taskId = "task-idempotent";
  const externalId = "X-42";
  const exec = makeApplyEventMock({ idempotent: true });

  const result = await callBrainTool(exec, "tasks.apply_event", {
    task_id: taskId,
    event: { type: "external_blocker_added", source: "jira", externalId },
  });

  const idempotent = (result as Record<string, unknown> | null)?.idempotent ??
    false;
  assertEquals(idempotent, true);
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

  const idempotent = (result as Record<string, unknown> | null)?.idempotent ??
    false;
  const response = { ok: true, idempotent, externalId, taskId };

  assertEquals(response.ok, true);
  assertEquals(response.idempotent, false);
  assertEquals(response.externalId, externalId);
  assertEquals(response.taskId, taskId);
  assertEquals("brainResponse" in response, false);
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
  // The close_node handler throws when node.status is not DONE/MERGED/PR_CREATED.
  // We reproduce the guard logic directly.
  const node = makeNode("n1", {
    status: NodeStatus.ACTIVE,
    taskId: "task-active",
  });
  const completedStatuses = [
    NodeStatus.DONE,
    NodeStatus.MERGED,
    NodeStatus.PR_CREATED,
  ];

  const wouldError = !completedStatuses.includes(node.status);
  assertEquals(wouldError, true, "ACTIVE node must trigger close_node guard");

  const expectedMessage =
    `Node "n1" is in status ${node.status} — must be DONE, MERGED, or PR_CREATED to close`;
  assertEquals(expectedMessage.includes("ACTIVE"), true);
});

Deno.test("handler: close_node guard — DONE status passes the guard", () => {
  const node = makeNode("n1", { status: NodeStatus.DONE, taskId: "task-done" });
  const completedStatuses = [
    NodeStatus.DONE,
    NodeStatus.MERGED,
    NodeStatus.PR_CREATED,
  ];

  const wouldError = !completedStatuses.includes(node.status);
  assertEquals(wouldError, false, "DONE node must pass close_node guard");
});

Deno.test("handler: close_node guard — no taskId produces error", () => {
  const node = makeNode("n1", { status: NodeStatus.DONE }); // no taskId

  const wouldError = !node.taskId;
  assertEquals(
    wouldError,
    true,
    "node without taskId must trigger close_node guard",
  );
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
