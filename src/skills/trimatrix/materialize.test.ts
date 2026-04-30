/**
 * Round-trip tests for materialize_plan (UNM-735.13 / UNM-461).
 *
 * Builds a small synthetic graph: lead subgraph (2 nodes) + 1 explicit
 * adjunct subgraph + 1 derived adjunct subgraph. Asserts:
 * - Each subgraph has exactly one section in the Markdown output.
 * - Each node appears under exactly one subgraph.
 * - Section ordering is sg-lead first, explicit second, derived third.
 * - Wave assignment is wave-stable (each node carries its wave number).
 * - JSON format produces a valid MaterializedPlan structure.
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { buildPlan, materializePlan } from "./materialize.ts";
import {
  CoordinationMode,
  Executor,
  Intent,
  MachineState,
  NodeStatus,
  NodeType,
  SubgraphCompletionPolicy,
  SubgraphFailurePolicy,
  SubgraphStrategy,
  Tier,
} from "./types.ts";
import type { Checkpoint, Graph, Node, Subgraph, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    type: NodeType.IMPLEMENTATION,
    label: `Label ${id}`,
    status: NodeStatus.PENDING,
    executor: Executor.LEAD,
    ...extra,
  };
}

function makeGraph(nodes: Node[]): Graph {
  const nodeMap: Record<string, Node> = {};
  for (const n of nodes) nodeMap[n.id] = n;
  return { nodes: nodeMap, edges: [] };
}

function makeSg(
  id: string,
  nodeIds: string[],
  derived: boolean,
  executor: Executor = Executor.ADJUNCT,
): Subgraph {
  return {
    id,
    derived,
    nodes: nodeIds,
    edges: [],
    assignee: derived ? "auto-adjunct" : "explicit-adjunct",
    executor,
    tier: Tier.T2,
    coordination: { mode: CoordinationMode.NONE },
    completionPolicy: SubgraphCompletionPolicy.ALL,
    failurePolicy: SubgraphFailurePolicy.FAIL_FAST,
    gates: [],
  };
}

function makeCp(
  graph: Graph,
  subgraphs: Subgraph[],
  waves: Wave[],
  overrides: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    version: "2.9.0",
    machineState: MachineState.DISPATCHING,
    graph,
    waves,
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subgraphs,
    episodeIds: [],
    eventLog: [],
    sessionLabel: "test-session",
    intent: Intent.IMPLEMENT,
    tier: Tier.T2,
    subgraphStrategy: SubgraphStrategy.INDEPENDENT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build test fixture: 5-node graph across 3 subgraphs, 2 waves
//
// Lead:     lead-a (wave 1), lead-b (wave 2)
// Explicit: explicit-x (wave 1)
// Derived:  derived-p (wave 1), derived-q (wave 2)
// ---------------------------------------------------------------------------

const leadA = makeNode("lead-a", {
  executor: Executor.LEAD,
  repo: "repo-main",
  taskId: "task-1",
});
const leadB = makeNode("lead-b", {
  executor: Executor.LEAD,
  status: NodeStatus.DONE,
  prUrl: "https://github.com/pr/1",
});
const explicitX = makeNode("explicit-x", {
  executor: Executor.ADJUNCT,
  tags: ["alpha", "beta"],
});
const derivedP = makeNode("derived-p", { executor: Executor.ADJUNCT });
const derivedQ = makeNode("derived-q", { executor: Executor.ADJUNCT });

const graph = makeGraph([leadA, leadB, explicitX, derivedP, derivedQ]);

const sgLead = makeSg("sg-lead", ["lead-a", "lead-b"], false, Executor.LEAD);
Object.assign(sgLead, { assignee: "LEAD" });

const sgExplicit = makeSg(
  "auth-service",
  ["explicit-x"],
  false,
  Executor.ADJUNCT,
);
const sgDerived = makeSg(
  "auto-abcd1234",
  ["derived-p", "derived-q"],
  true,
  Executor.ADJUNCT,
);

const waves: Wave[] = [
  { id: 1, nodes: ["lead-a", "explicit-x", "derived-p"], hasMergeGate: false },
  { id: 2, nodes: ["lead-b", "derived-q"], hasMergeGate: false },
];

const cp = makeCp(graph, [sgLead, sgExplicit, sgDerived], waves);

// ---------------------------------------------------------------------------
// Tests: buildPlan
// ---------------------------------------------------------------------------

Deno.test("buildPlan: returns correct node count", () => {
  const plan = buildPlan(cp);
  assertEquals(plan.nodeCount, 5);
});

Deno.test("buildPlan: returns correct wave count", () => {
  const plan = buildPlan(cp);
  assertEquals(plan.waveCount, 2);
});

Deno.test("buildPlan: subgraph ordering — sg-lead, explicit, derived", () => {
  const plan = buildPlan(cp);
  assertEquals(plan.subgraphs.length, 3);
  assertEquals(plan.subgraphs[0].id, "sg-lead");
  assertEquals(plan.subgraphs[1].id, "auth-service");
  assertEquals(plan.subgraphs[2].id, "auto-abcd1234");
});

Deno.test("buildPlan: each node appears under exactly one subgraph", () => {
  const plan = buildPlan(cp);
  const seen = new Set<string>();
  for (const sg of plan.subgraphs) {
    for (const node of sg.nodes) {
      assertEquals(
        seen.has(node.id),
        false,
        `node ${node.id} appeared in multiple subgraphs`,
      );
      seen.add(node.id);
    }
  }
  assertEquals(seen.size, 5);
});

Deno.test("buildPlan: wave assignment is wave-stable", () => {
  const plan = buildPlan(cp);

  // Find nodes by id across all subgraphs
  const allNodes = plan.subgraphs.flatMap((sg) => sg.nodes);
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  assertEquals(byId.get("lead-a")?.wave, 1);
  assertEquals(byId.get("lead-b")?.wave, 2);
  assertEquals(byId.get("explicit-x")?.wave, 1);
  assertEquals(byId.get("derived-p")?.wave, 1);
  assertEquals(byId.get("derived-q")?.wave, 2);
});

Deno.test("buildPlan: node fields — repo, taskId, prUrl, tags, status", () => {
  const plan = buildPlan(cp);
  const allNodes = plan.subgraphs.flatMap((sg) => sg.nodes);
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  const la = byId.get("lead-a")!;
  assertEquals(la.repo, "repo-main");
  assertEquals(la.taskId, "task-1");
  assertEquals(la.status, NodeStatus.PENDING);

  const lb = byId.get("lead-b")!;
  assertEquals(lb.status, NodeStatus.DONE);
  assertEquals(lb.prUrl, "https://github.com/pr/1");

  const ex = byId.get("explicit-x")!;
  assertEquals(ex.tags, ["alpha", "beta"]);
});

Deno.test("buildPlan: subgraph metadata — executor, tier, outcome", () => {
  const plan = buildPlan(cp);
  const lead = plan.subgraphs.find((sg) => sg.id === "sg-lead")!;
  assertEquals(lead.executor, Executor.LEAD);
  assertEquals(lead.tier, Tier.T2);
  // All lead nodes pending → outcome is "pending"
  assertEquals(lead.outcome, "pending");
});

// ---------------------------------------------------------------------------
// Tests: materializePlan — Markdown
// ---------------------------------------------------------------------------

Deno.test("materializePlan(markdown): contains session label in title", () => {
  const md = materializePlan(cp, "markdown");
  assertStringIncludes(md, "# Plan: test-session");
});

Deno.test("materializePlan(markdown): contains overview section", () => {
  const md = materializePlan(cp, "markdown");
  assertStringIncludes(md, "## Overview");
  assertStringIncludes(md, "Waves: 2");
  assertStringIncludes(md, "Nodes: 5");
  assertStringIncludes(md, "Intent: IMPLEMENT");
});

Deno.test("materializePlan(markdown): sg-lead section appears first", () => {
  const md = materializePlan(cp, "markdown");
  const leadIdx = md.indexOf("## Lead Subgraph (sg-lead)");
  const explicitIdx = md.indexOf("## Subgraph: auth-service");
  const derivedIdx = md.indexOf("## Subgraph: auto-abcd1234");
  assertEquals(
    leadIdx < explicitIdx,
    true,
    "sg-lead must precede auth-service",
  );
  assertEquals(explicitIdx < derivedIdx, true, "explicit must precede derived");
});

Deno.test("materializePlan(markdown): each subgraph has exactly one header", () => {
  const md = materializePlan(cp, "markdown");
  const leadCount = (md.match(/## Lead Subgraph \(sg-lead\)/g) ?? []).length;
  const explicitCount = (md.match(/## Subgraph: auth-service/g) ?? []).length;
  const derivedCount = (md.match(/## Subgraph: auto-abcd1234/g) ?? []).length;
  assertEquals(leadCount, 1);
  assertEquals(explicitCount, 1);
  assertEquals(derivedCount, 1);
});

Deno.test("materializePlan(markdown): all node IDs appear in output", () => {
  const md = materializePlan(cp, "markdown");
  for (
    const nodeId of ["lead-a", "lead-b", "explicit-x", "derived-p", "derived-q"]
  ) {
    assertStringIncludes(md, nodeId);
  }
});

Deno.test("materializePlan(markdown): explicit subgraph labeled as (explicit)", () => {
  const md = materializePlan(cp, "markdown");
  assertStringIncludes(md, "(explicit)");
});

Deno.test("materializePlan(markdown): derived subgraph labeled as (derived)", () => {
  const md = materializePlan(cp, "markdown");
  assertStringIncludes(md, "(derived)");
});

Deno.test("materializePlan(markdown): tags appear in node row", () => {
  const md = materializePlan(cp, "markdown");
  assertStringIncludes(md, "alpha, beta");
});

Deno.test("materializePlan(markdown): prUrl appears in node row", () => {
  const md = materializePlan(cp, "markdown");
  assertStringIncludes(md, "https://github.com/pr/1");
});

// ---------------------------------------------------------------------------
// Tests: materializePlan — JSON
// ---------------------------------------------------------------------------

Deno.test("materializePlan(json): parses to valid MaterializedPlan", () => {
  const raw = materializePlan(cp, "json");
  const plan = JSON.parse(raw);
  assertEquals(plan.sessionLabel, "test-session");
  assertEquals(plan.waveCount, 2);
  assertEquals(plan.nodeCount, 5);
  assertEquals(Array.isArray(plan.subgraphs), true);
  assertEquals(plan.subgraphs.length, 3);
});

Deno.test("materializePlan(json): subgraph ordering matches spec", () => {
  const raw = materializePlan(cp, "json");
  const plan = JSON.parse(raw);
  assertEquals(plan.subgraphs[0].id, "sg-lead");
  assertEquals(plan.subgraphs[1].id, "auth-service");
  assertEquals(plan.subgraphs[2].id, "auto-abcd1234");
});

Deno.test("materializePlan(json): each node appears under exactly one subgraph", () => {
  const raw = materializePlan(cp, "json");
  const plan = JSON.parse(raw);
  const seen = new Set<string>();
  for (const sg of plan.subgraphs) {
    for (const node of sg.nodes) {
      assertEquals(seen.has(node.id), false, `duplicate node: ${node.id}`);
      seen.add(node.id);
    }
  }
  assertEquals(seen.size, 5);
});

Deno.test("materializePlan(json): wave numbers are present on nodes", () => {
  const raw = materializePlan(cp, "json");
  const plan = JSON.parse(raw);
  const allNodes = plan.subgraphs.flatMap((
    sg: { nodes: Array<{ id: string; wave: number }> },
  ) => sg.nodes);
  const byId = new Map<string, { id: string; wave: number }>(
    allNodes.map((n: { id: string; wave: number }) => [n.id, n]),
  );
  assertEquals(byId.get("lead-a")!.wave, 1);
  assertEquals(byId.get("lead-b")!.wave, 2);
  assertEquals(byId.get("derived-q")!.wave, 2);
});

// ---------------------------------------------------------------------------
// Tests: default format (no param → markdown)
// ---------------------------------------------------------------------------

Deno.test("materializePlan: default format is markdown", () => {
  const result = materializePlan(cp);
  assertStringIncludes(result, "# Plan:");
  assertMatch(result, /^# Plan:/m);
});

// ---------------------------------------------------------------------------
// Edge case: empty subgraphs list
// ---------------------------------------------------------------------------

Deno.test("materializePlan: empty subgraphs produces valid minimal output", () => {
  const emptyCp = makeCp(graph, [], [], { sessionLabel: "empty" });
  const md = materializePlan(emptyCp, "markdown");
  assertStringIncludes(md, "# Plan: empty");
  assertStringIncludes(md, "## Overview");
});

Deno.test("buildPlan: multiple explicit subgraphs sorted by slug", () => {
  const sgZ = makeSg("z-service", ["explicit-x"], false);
  const sgA = makeSg("a-service", ["derived-p"], false);
  const sgM = makeSg("m-service", ["derived-q"], false);
  const multiCp = makeCp(graph, [sgLead, sgZ, sgA, sgM], waves);
  const plan = buildPlan(multiCp);
  // sg-lead, then a-service, m-service, z-service
  assertEquals(plan.subgraphs[0].id, "sg-lead");
  assertEquals(plan.subgraphs[1].id, "a-service");
  assertEquals(plan.subgraphs[2].id, "m-service");
  assertEquals(plan.subgraphs[3].id, "z-service");
});

// ---------------------------------------------------------------------------
// Gap coverage (MEDIUM-D2): single-node, max-fan-out, all-completed,
// mixed-status renderings — UNM-735.16 Delta
// Four of Four, Tertiary Drone Protocol of Trimatrix 702
// ---------------------------------------------------------------------------

Deno.test("materializePlan(markdown): single-node graph — valid output, no errors", () => {
  const solo = makeNode("solo-1", { executor: Executor.LEAD });
  const soloGraph = makeGraph([solo]);
  const soloSg = makeSg("sg-solo", ["solo-1"], false, Executor.LEAD);
  Object.assign(soloSg, { assignee: "LEAD" });
  const soloWaves: Wave[] = [{ id: 1, nodes: ["solo-1"], hasMergeGate: false }];
  const soloCp = makeCp(soloGraph, [soloSg], soloWaves, {
    sessionLabel: "solo-session",
  });

  const md = materializePlan(soloCp, "markdown");
  assertStringIncludes(md, "# Plan: solo-session");
  assertStringIncludes(md, "Nodes: 1");
  assertStringIncludes(md, "solo-1");
});

Deno.test("materializePlan(markdown): max-fan-out — 1 root, 10 dependents all in topo order under subgraph", () => {
  // Build a graph: root → dep-0 … dep-9
  const root = makeNode("fan-root", { executor: Executor.LEAD });
  const deps = Array.from(
    { length: 10 },
    (_, i) => makeNode(`fan-dep-${i}`, { executor: Executor.ADJUNCT }),
  );
  const allNodes = [root, ...deps];
  const fanGraph = makeGraph(allNodes);

  const sgFanLead = makeSg("sg-fan-lead", ["fan-root"], false, Executor.LEAD);
  Object.assign(sgFanLead, { assignee: "LEAD" });
  const sgFanAdj = makeSg(
    "sg-fan-adjuncts",
    deps.map((d) => d.id),
    true,
    Executor.ADJUNCT,
  );

  const fanWaves: Wave[] = [
    { id: 1, nodes: ["fan-root"], hasMergeGate: false },
    {
      id: 2,
      nodes: deps.map((d) => d.id),
      hasMergeGate: false,
    },
  ];
  const fanCp = makeCp(fanGraph, [sgFanLead, sgFanAdj], fanWaves, {
    sessionLabel: "fan-session",
  });

  const plan = buildPlan(fanCp);
  // fan-root appears in sg-fan-lead (wave 1).
  const leadSg = plan.subgraphs.find((sg) => sg.id === "sg-fan-lead")!;
  assertEquals(leadSg.nodes.length, 1);
  assertEquals(leadSg.nodes[0].id, "fan-root");

  // All 10 dependents appear in sg-fan-adjuncts.
  const adjSg = plan.subgraphs.find((sg) => sg.id === "sg-fan-adjuncts")!;
  assertEquals(adjSg.nodes.length, 10);

  // All 10 node IDs are present.
  const adjIds = new Set(adjSg.nodes.map((n) => n.id));
  for (let i = 0; i < 10; i++) {
    assertEquals(adjIds.has(`fan-dep-${i}`), true, `fan-dep-${i} missing`);
  }

  // Markdown contains all node IDs.
  const md = materializePlan(fanCp, "markdown");
  assertStringIncludes(md, "Nodes: 11");
  for (let i = 0; i < 10; i++) {
    assertStringIncludes(md, `fan-dep-${i}`);
  }
});

Deno.test("materializePlan(markdown): all-completed graph — status indicators render correctly", () => {
  const doneA = makeNode("done-a", {
    executor: Executor.LEAD,
    status: NodeStatus.DONE,
  });
  const doneB = makeNode("done-b", {
    executor: Executor.LEAD,
    status: NodeStatus.DONE,
    prUrl: "https://github.com/pr/done-b",
  });
  const doneGraph = makeGraph([doneA, doneB]);
  const doneSg = makeSg("sg-done", ["done-a", "done-b"], false, Executor.LEAD);
  Object.assign(doneSg, { assignee: "LEAD" });
  const doneWaves: Wave[] = [
    { id: 1, nodes: ["done-a", "done-b"], hasMergeGate: false },
  ];
  const doneCp = makeCp(doneGraph, [doneSg], doneWaves, {
    sessionLabel: "done-session",
  });

  const plan = buildPlan(doneCp);
  const allNodes = plan.subgraphs.flatMap((sg) => sg.nodes);
  // All nodes report DONE.
  for (const n of allNodes) {
    assertEquals(n.status, NodeStatus.DONE);
  }

  const md = materializePlan(doneCp, "markdown");
  assertStringIncludes(md, "done-a");
  assertStringIncludes(md, "done-b");
  // prUrl for done-b is present.
  assertStringIncludes(md, "https://github.com/pr/done-b");
});

Deno.test("materializePlan(markdown): mixed-status graph — PENDING/ACTIVE/DONE/FAILED/BLOCKED render distinctively", () => {
  const nPending = makeNode("mix-pending", {
    executor: Executor.LEAD,
    status: NodeStatus.PENDING,
  });
  const nActive = makeNode("mix-active", {
    executor: Executor.LEAD,
    status: NodeStatus.ACTIVE,
  });
  const nDone = makeNode("mix-done", {
    executor: Executor.LEAD,
    status: NodeStatus.DONE,
  });
  const nFailed = makeNode("mix-failed", {
    executor: Executor.LEAD,
    status: NodeStatus.FAILED,
    failureReason: "cap exhausted",
  });
  const nBlocked = makeNode("mix-blocked", {
    executor: Executor.LEAD,
    status: NodeStatus.BLOCKED,
  });

  const mixGraph = makeGraph([nPending, nActive, nDone, nFailed, nBlocked]);
  const mixSg = makeSg(
    "sg-mix",
    ["mix-pending", "mix-active", "mix-done", "mix-failed", "mix-blocked"],
    false,
    Executor.LEAD,
  );
  Object.assign(mixSg, { assignee: "LEAD" });
  const mixWaves: Wave[] = [
    {
      id: 1,
      nodes: [
        "mix-pending",
        "mix-active",
        "mix-done",
        "mix-failed",
        "mix-blocked",
      ],
      hasMergeGate: false,
    },
  ];
  const mixCp = makeCp(mixGraph, [mixSg], mixWaves, {
    sessionLabel: "mix-session",
  });

  const plan = buildPlan(mixCp);
  const allNodes = plan.subgraphs.flatMap((sg) => sg.nodes);
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  // Each node carries its own distinct status.
  assertEquals(byId.get("mix-pending")!.status, NodeStatus.PENDING);
  assertEquals(byId.get("mix-active")!.status, NodeStatus.ACTIVE);
  assertEquals(byId.get("mix-done")!.status, NodeStatus.DONE);
  assertEquals(byId.get("mix-failed")!.status, NodeStatus.FAILED);
  assertEquals(byId.get("mix-blocked")!.status, NodeStatus.BLOCKED);

  // Markdown includes all node IDs (each status renders without crashing).
  const md = materializePlan(mixCp, "markdown");
  assertStringIncludes(md, "mix-pending");
  assertStringIncludes(md, "mix-active");
  assertStringIncludes(md, "mix-done");
  assertStringIncludes(md, "mix-failed");
  assertStringIncludes(md, "mix-blocked");

  // Outcome field on the subgraph reflects mixed state (not "completed").
  const leadSg = plan.subgraphs.find((sg) => sg.id === "sg-mix")!;
  // With DONE, FAILED, ACTIVE, PENDING, BLOCKED nodes the outcome is not "completed".
  assertEquals(leadSg.outcome !== "completed", true);
});
