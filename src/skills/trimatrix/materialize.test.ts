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
