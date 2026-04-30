/**
 * saga_report.ts — Post-saga aggregate report for the trimatrix convergence loop.
 *
 * After all nodes reach a terminal status (DONE, MERGED, FAILED), the lead calls
 * `saga_report` to produce a structured summary of convergence quality. The report
 * aggregates checkpoint state and, when a sessionLabel is present, reads C7
 * node-summary records from the brain.
 *
 * Pure function — no checkpoint mutation, no writes.
 */

import { NodeStatus } from "./types.ts";
import type { Checkpoint } from "./types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EscalationEntry {
  nodeId: string;
  reason: string;
  lastReviewNotes?: string;
}

export interface NodeSummaryEntry {
  nodeId: string;
  status: string;
  commits: string[];
  whatChanged: string;
}

export interface SagaReport {
  totalNodes: number;
  /** DONE/MERGED with iterationCount > 0 */
  converged: number;
  /** DONE/MERGED with iterationCount === 0 */
  oneShot: number;
  /** FAILED (cap exhausted or other) */
  failed: number;
  avgIterations: number;
  maxIterationsObserved: number;
  /** Nodes that exceeded the review cap (FAILED with iterationCount at maxIterations) */
  escalations: EscalationEntry[];
  /** C7 node-summary records aggregated from brain, when available */
  nodeSummaries: NodeSummaryEntry[];
}

export type SagaReportFormat = "markdown" | "json";

// ---------------------------------------------------------------------------
// Terminal status helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<string>([
  NodeStatus.DONE,
  NodeStatus.MERGED,
  NodeStatus.FAILED,
]);

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isSuccess(status: string): boolean {
  return status === NodeStatus.DONE || status === NodeStatus.MERGED;
}

// ---------------------------------------------------------------------------
// Core aggregation
// ---------------------------------------------------------------------------

/**
 * Build a SagaReport from the checkpoint and pre-fetched node-summary records.
 *
 * @param cp - The current checkpoint (read-only).
 * @param nodeSummaries - C7 records fetched from the brain, or empty when unavailable.
 */
export function buildSagaReport(
  cp: Checkpoint,
  nodeSummaries: NodeSummaryEntry[] = [],
): SagaReport {
  const nodes = Object.values(cp.graph.nodes);

  let converged = 0;
  let oneShot = 0;
  let failed = 0;
  let totalIterations = 0;
  let maxIterationsObserved = 0;
  const escalations: EscalationEntry[] = [];

  for (const node of nodes) {
    if (!isTerminal(node.status)) continue;

    const iters = node.iterationCount ?? 0;
    totalIterations += iters;
    if (iters > maxIterationsObserved) maxIterationsObserved = iters;

    if (isSuccess(node.status)) {
      if (iters > 0) {
        converged++;
      } else {
        oneShot++;
      }
    } else if (node.status === NodeStatus.FAILED) {
      failed++;
      // Detect cap-exhaustion escalations: iterationCount reached maxIterations.
      // Also include nodes that failed after at least one failed review.
      if (iters > 0 || node.lastReviewVerdict === "FAIL") {
        escalations.push({
          nodeId: node.id,
          reason: node.failureReason ??
            (iters >= (node.maxIterations ?? 3)
              ? `Cap exhausted (${iters}/${node.maxIterations ?? 3} iterations)`
              : "Review failed"),
          lastReviewNotes: node.lastReviewNotes,
        });
      }
    }
  }

  const terminalCount = converged + oneShot + failed;
  const avgIterations = terminalCount > 0
    ? Math.round((totalIterations / terminalCount) * 100) / 100
    : 0;

  return {
    totalNodes: nodes.length,
    converged,
    oneShot,
    failed,
    avgIterations,
    maxIterationsObserved,
    escalations,
    nodeSummaries,
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a SagaReport as a compact Markdown string (<40 lines for a 10-node saga).
 */
export function renderSagaReportMarkdown(report: SagaReport): string {
  const lines: string[] = [];

  lines.push("# Saga Convergence Report");
  lines.push("");

  lines.push("## Summary");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Total nodes | ${report.totalNodes} |`);
  lines.push(`| One-shot (no retries) | ${report.oneShot} |`);
  lines.push(`| Converged (retried) | ${report.converged} |`);
  lines.push(`| Failed | ${report.failed} |`);
  lines.push(`| Avg iterations | ${report.avgIterations} |`);
  lines.push(`| Max iterations observed | ${report.maxIterationsObserved} |`);
  lines.push("");

  if (report.escalations.length > 0) {
    lines.push("## Escalations");
    for (const e of report.escalations) {
      lines.push(
        `- **${e.nodeId}**: ${e.reason}${
          e.lastReviewNotes ? ` — ${e.lastReviewNotes}` : ""
        }`,
      );
    }
    lines.push("");
  }

  if (report.nodeSummaries.length > 0) {
    lines.push("## Node Summaries");
    for (const s of report.nodeSummaries) {
      const commits = s.commits.length > 0 ? s.commits.join(", ") : "none";
      lines.push(
        `- **${s.nodeId}** [${s.status}]: ${s.whatChanged} (commits: ${commits})`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render a SagaReport as Markdown or JSON.
 *
 * @param report - Pre-built report object.
 * @param format - Output format ("markdown" | "json"). Defaults to "markdown".
 */
export function renderSagaReport(
  report: SagaReport,
  format: SagaReportFormat = "markdown",
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  return renderSagaReportMarkdown(report);
}
