/**
 * materialize.ts — Plan materialization for the trimatrix supergraph.
 *
 * Renders the full execution plan as a single Markdown (or JSON) document,
 * grouping nodes by their owning subgraph. Order: sg-lead first, then
 * explicit subgraphs sorted by slug, then derived subgraphs sorted by id.
 * Within each subgraph, nodes appear in topological order (wave-stable).
 *
 * Pure function — no side effects, no checkpoint mutation.
 */

import { subgraphOutcome } from "./graph.ts";
import type { Checkpoint, Graph, Node, Subgraph, Wave } from "./types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a map from nodeId → wave number, derived from the checkpoint's waves.
 */
function buildWaveMap(waves: Wave[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const wave of waves) {
    for (const nodeId of wave.nodes) {
      m.set(nodeId, wave.id);
    }
  }
  return m;
}

/**
 * Sort subgraphs: sg-lead first, then explicit (sorted slug), then derived (sorted id).
 */
function sortSubgraphs(subgraphs: Subgraph[]): Subgraph[] {
  const lead = subgraphs.filter((sg) => sg.id === "sg-lead");
  const explicit = subgraphs
    .filter((sg) => sg.id !== "sg-lead" && !sg.derived)
    .sort((a, b) => a.id.localeCompare(b.id));
  const derived = subgraphs
    .filter((sg) => sg.derived && sg.id !== "sg-lead")
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...lead, ...explicit, ...derived];
}

/**
 * Render a per-node table row for Markdown output.
 */
function nodeRow(
  node: Node,
  wave: number | undefined,
): string {
  const waveCell = wave !== undefined ? String(wave) : "—";
  const repoCell = node.repo ?? "—";
  const taskCell = node.taskId ?? "—";
  const prCell = node.prUrl ?? "—";
  const readiness = node.readinessStatus ?? "—";
  const tags = node.tags?.length ? node.tags.join(", ") : "—";
  return `| ${node.id} | ${node.label} | ${waveCell} | ${node.type} | ${node.status} | ${readiness} | ${repoCell} | ${taskCell} | ${prCell} | ${tags} |`;
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type MaterializeFormat = "markdown" | "json";

export interface MaterializedPlan {
  sessionId?: string;
  sessionLabel?: string;
  intent?: string;
  tier?: string;
  subgraphStrategy?: string;
  waveCount: number;
  nodeCount: number;
  subgraphs: MaterializedSubgraph[];
}

export interface MaterializedSubgraph {
  id: string;
  label?: string;
  derived: boolean;
  executor: string;
  tier: string;
  assignee: string;
  coordinationMode: string;
  completionPolicy: string;
  failurePolicy: string;
  gates: Array<string | Record<string, unknown>>;
  outcome: string;
  nodes: MaterializedNode[];
}

export interface MaterializedNode {
  id: string;
  label: string;
  wave: number | undefined;
  type: string;
  status: string;
  readinessStatus: string | undefined;
  repo: string | undefined;
  taskId: string | undefined;
  prUrl: string | undefined;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Core: build structured plan object
// ---------------------------------------------------------------------------

/**
 * Build the structured plan object from a checkpoint.
 * This is the single source of truth; both Markdown and JSON renderers consume it.
 */
export function buildPlan(cp: Checkpoint): MaterializedPlan {
  const subgraphs = cp.subgraphs ?? [];
  const graph: Graph = cp.graph;
  const waves: Wave[] = cp.waves ?? [];
  const waveMap = buildWaveMap(waves);

  const sorted = sortSubgraphs(subgraphs);

  const materializedSubgraphs: MaterializedSubgraph[] = sorted.map((sg) => {
    const outcome = subgraphOutcome(graph, sg);

    const nodes: MaterializedNode[] = sg.nodes.map((nodeId) => {
      const node: Node | undefined = graph.nodes[nodeId];
      if (!node) {
        // Phantom node reference — surface as unknown
        return {
          id: nodeId,
          label: "(unknown)",
          wave: waveMap.get(nodeId),
          type: "unknown",
          status: "unknown",
          readinessStatus: undefined,
          repo: undefined,
          taskId: undefined,
          prUrl: undefined,
          tags: [],
        };
      }
      return {
        id: node.id,
        label: node.label,
        wave: waveMap.get(node.id),
        type: node.type,
        status: node.status,
        readinessStatus: node.readinessStatus,
        repo: node.repo,
        taskId: node.taskId,
        prUrl: node.prUrl,
        tags: node.tags ?? [],
      };
    });

    return {
      id: sg.id,
      label: sg.label,
      derived: sg.derived,
      executor: sg.executor,
      tier: sg.tier,
      assignee: sg.assignee,
      coordinationMode: sg.coordination.mode,
      completionPolicy: sg.completionPolicy,
      failurePolicy: sg.failurePolicy,
      gates: (sg.gates ?? []) as Array<string | Record<string, unknown>>,
      outcome,
      nodes,
    };
  });

  const totalNodes = Object.keys(graph.nodes).length;

  return {
    sessionId: cp.sessionId,
    sessionLabel: cp.sessionLabel,
    intent: cp.intent,
    tier: cp.tier,
    subgraphStrategy: cp.subgraphStrategy,
    waveCount: waves.length,
    nodeCount: totalNodes,
    subgraphs: materializedSubgraphs,
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(plan: MaterializedPlan): string {
  const lines: string[] = [];

  const title = plan.sessionLabel
    ? `# Plan: ${plan.sessionLabel}`
    : "# Plan: (unlabeled session)";
  lines.push(title);
  lines.push("");

  lines.push("## Overview");
  if (plan.sessionId) lines.push(`- Session: ${plan.sessionId}`);
  const intentStr = plan.intent ?? "—";
  const tierStr = plan.tier ?? "—";
  const stratStr = plan.subgraphStrategy ?? "—";
  lines.push(`- Intent: ${intentStr} · Tier: ${tierStr} · Strategy: ${stratStr}`);
  lines.push(`- Waves: ${plan.waveCount} · Nodes: ${plan.nodeCount}`);
  lines.push("");

  for (const sg of plan.subgraphs) {
    const kindTag = sg.derived ? "derived" : "explicit";
    const labelPart = sg.label ? ` — ${sg.label}` : "";

    if (sg.id === "sg-lead") {
      lines.push(`## Lead Subgraph (sg-lead)${labelPart}`);
    } else {
      lines.push(`## Subgraph: ${sg.id}${labelPart} (${kindTag})`);
    }

    lines.push(
      `**Executor:** ${sg.executor} · **Tier:** ${sg.tier} · **Assignee:** ${sg.assignee} · **Coordination:** ${sg.coordinationMode} · **Outcome:** ${sg.outcome}`,
    );
    lines.push(
      `**Completion:** ${sg.completionPolicy} · **Failure:** ${sg.failurePolicy}`,
    );
    if (sg.gates.length > 0) {
      const gateStrs = sg.gates.map((g) =>
        typeof g === "string" ? g : JSON.stringify(g)
      );
      lines.push(`**Gates:** ${gateStrs.join(", ")}`);
    }
    lines.push("");

    lines.push(
      "| Node | Label | Wave | Type | Status | Readiness | Repo | Task | PR | Tags |",
    );
    lines.push(
      "|---|---|---|---|---|---|---|---|---|---|",
    );

    for (const node of sg.nodes) {
      lines.push(nodeRow(
        {
          id: node.id,
          label: node.label,
          type: node.type as never,
          status: node.status as never,
          readinessStatus: node.readinessStatus as never | undefined,
          repo: node.repo,
          taskId: node.taskId,
          prUrl: node.prUrl,
          tags: node.tags,
          executor: sg.executor as never,
        },
        node.wave,
      ));
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Materialize the full execution plan as a Markdown or JSON string.
 *
 * @param cp - The current checkpoint (read-only).
 * @param format - Output format: "markdown" (default) or "json".
 * @returns Rendered plan string.
 */
export function materializePlan(
  cp: Checkpoint,
  format: MaterializeFormat = "markdown",
): string {
  const plan = buildPlan(cp);
  if (format === "json") {
    return JSON.stringify(plan, null, 2);
  }
  return renderMarkdown(plan);
}
