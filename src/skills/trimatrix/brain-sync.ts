/**
 * Brain CLI interaction layer for task status syncing.
 *
 * Extracted from server.ts to enable unit testing of the cwd-routing logic
 * without a running brain CLI or MCP server.
 */

import type { EpisodeStub, Graph, RepoMetadata } from "./types.ts";

// ---------------------------------------------------------------------------
// Executor abstraction
// ---------------------------------------------------------------------------

/** Abstraction over child-process execution for dependency injection. */
export interface BrainExec {
  /** Run a command with optional stdin, like `execWithStdin`. */
  withStdin(
    cmd: string,
    args: string[],
    stdinData?: string,
    timeout?: number,
    cwd?: string,
  ): Promise<string>;

  /** Run a command without stdin, like `execFileAsync`. */
  exec(
    cmd: string,
    args: string[],
    opts?: { timeout?: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// BrainError
// ---------------------------------------------------------------------------

/** Typed error thrown when brain MCP returns an error payload. */
export class BrainError extends Error {
  code: number | undefined;

  constructor(message: string, code?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrainError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// callBrainTool
// ---------------------------------------------------------------------------

/**
 * Invoke a brain MCP tool via the `tools/call` JSON-RPC envelope.
 *
 * Throws `BrainError` when the brain returns an error payload.
 * Logs and rethrows on transport/parse failures.
 */
export async function callBrainTool(
  brainExec: BrainExec,
  toolName: string,
  args: Record<string, unknown>,
  opts?: { timeout?: number; cwd?: string },
): Promise<unknown> {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  let raw: string;
  try {
    raw = await brainExec.withStdin(
      BRAIN_CLI,
      ["mcp"],
      request,
      opts?.timeout ?? 5000,
      opts?.cwd,
    );
  } catch (err) {
    console.error(
      `[brain-sync] callBrainTool transport failure (${toolName}):`,
      err,
    );
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[brain-sync] callBrainTool parse failure (${toolName}):`,
      err,
    );
    throw new BrainError(
      `Failed to parse brain response (${toolName}): malformed JSON envelope`,
      undefined,
      { cause: err },
    );
  }

  if (parsed.error) {
    const e = parsed.error as { message?: string; code?: number };
    throw new BrainError(e.message ?? "Brain RPC error", e.code);
  }

  const text = (parsed as { result?: { content?: Array<{ text?: string }> } })
    ?.result?.content?.[0]?.text;
  if (text !== undefined) {
    try {
      return JSON.parse(text);
    } catch (err) {
      console.error(
        `[brain-sync] callBrainTool inner-parse failure (${toolName}):`,
        err,
      );
      throw new BrainError(
        `Failed to parse inner brain response (${toolName}): malformed JSON content`,
        undefined,
        { cause: err },
      );
    }
  }

  return (parsed as { result?: unknown }).result;
}

// ---------------------------------------------------------------------------
// buildExternalBlockerResponse — shared response shaper for add/resolve handlers
// ---------------------------------------------------------------------------

/**
 * Shape the MCP tool response for add_external_blocker / resolve_external_blocker.
 *
 * Extracted so production handlers and contract tests share the same logic;
 * tests are not tautological because they exercise this exact function.
 *
 * - `idempotent` is `true` only when the brain result explicitly carries
 *   `idempotent: true`. Anything else (false, missing, wrong type) → false.
 * - The response intentionally omits the raw brain envelope; only the four
 *   stable fields are surfaced.
 */
export function buildExternalBlockerResponse(
  taskId: string,
  externalId: string,
  brainResult: unknown,
): { ok: true; idempotent: boolean; externalId: string; taskId: string } {
  const idempotent =
    (brainResult as Record<string, unknown> | null | undefined)?.idempotent ===
      true;
  return { ok: true, idempotent, externalId, taskId };
}

// ---------------------------------------------------------------------------
// repoRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the filesystem root for a node's repo from the repos array.
 * Returns undefined for single-repo nodes (no repo field) — callers
 * fall back to the server's working directory.
 */
export function repoRoot(
  repos: RepoMetadata[],
  repoName?: string,
): string | undefined {
  if (!repoName || repos.length === 0) return undefined;
  const match = repos.find((r) => r.name === repoName);
  if (!match) {
    throw new Error(
      `Repo "${repoName}" not found in checkpoint. ` +
        `Available: ${repos.map((r) => r.name).join(", ") || "(none)"}`,
    );
  }
  return match.root;
}

// ---------------------------------------------------------------------------
// syncTaskStatus
// ---------------------------------------------------------------------------

const BRAIN_CLI = "brain";

/**
 * Sync a graph node's status to the brain task system (best-effort).
 * Accepts an injectable executor for testing; production callers pass
 * the real exec layer.
 */
export async function syncTaskStatus(
  taskId: string,
  action: "activate" | "block" | "close",
  cwd?: string,
  exec?: BrainExec,
): Promise<void> {
  if (!exec) return;
  try {
    if (action === "close") {
      await exec.exec(BRAIN_CLI, ["tasks", "close", taskId], {
        timeout: 5000,
        ...(cwd ? { cwd } : {}),
      });
    } else {
      const newStatus = action === "activate" ? "in_progress" : "blocked";
      await callBrainTool(
        exec,
        "tasks.apply_event",
        {
          task_id: taskId,
          event: { type: "status_changed", status: newStatus },
        },
        { timeout: 5000, ...(cwd ? { cwd } : {}) },
      );
    }
  } catch (err) {
    console.error(
      `[brain-sync] syncTaskStatus failed for task ${taskId}:`,
      err,
    );
    // Best-effort — graph remains source of truth
  }
}

// ---------------------------------------------------------------------------
// writeEpisode
// ---------------------------------------------------------------------------

/**
 * Write an episode to brain's episodic memory (best-effort).
 * Returns the summary_id on success, null on failure.
 */
export async function writeEpisode(
  goal: string,
  actions: string[],
  outcome: string,
  tags: string[],
  importance?: number,
  cwd?: string,
  exec?: BrainExec,
): Promise<string | null> {
  if (!exec) return null;
  try {
    const result = await callBrainTool(
      exec,
      "memory.write_episode",
      {
        goal,
        actions: actions.join("\n"),
        outcome,
        tags,
        ...(importance !== undefined ? { importance } : {}),
      },
      { timeout: 5000, ...(cwd ? { cwd } : {}) },
    ) as Record<string, unknown> | null | undefined;
    return (result as { summary_id?: string })?.summary_id ?? null;
  } catch (err) {
    console.error("[brain-sync] writeEpisode failed:", err);
    return null;
  }
}

/**
 * Extract a bare summary id from a `memory.retrieve` result row.
 *
 * The brain returns the canonical id only inside `uri` / `source_uri`, in the
 * form `synapse://<brain>/episode/sum:<ulid>` — there is no top-level id
 * field. We pull the trailing path segment and strip the `sum:` prefix.
 *
 * Returns an empty string when neither field is present or parseable; callers
 * tolerate empty ids.
 */
function extractSummaryId(row: Record<string, unknown>): string {
  const uri = String(row.uri ?? row.source_uri ?? "");
  if (!uri) return "";
  const last = uri.split("/").pop() ?? "";
  return last.replace(/^sum:/, "");
}

// ---------------------------------------------------------------------------
// searchEpisodes
// ---------------------------------------------------------------------------

/**
 * Search brain's episodic memory for prior episodes (best-effort).
 * Returns matching episode stubs, or empty array on failure.
 *
 * `budget` is interpreted as a soft token budget and mapped to a `count` cap
 * (~100 tokens per episode stub). `memory.retrieve` does not accept
 * `budget_tokens`; the budget contract is upheld via the count cap and the
 * server-side `kinds: ["episode"]` filter.
 */
export async function searchEpisodes(
  query: string,
  tags?: string[],
  brains?: string[],
  budget?: number,
  cwd?: string,
  exec?: BrainExec,
): Promise<EpisodeStub[]> {
  if (!exec) return [];
  const count = Math.max(1, Math.floor((budget ?? 800) / 100));
  try {
    const result = await callBrainTool(
      exec,
      "memory.retrieve",
      {
        query,
        count,
        kinds: ["episode"],
        ...(tags ? { tags } : {}),
        ...(brains ? { brains } : {}),
      },
      { timeout: 5000, ...(cwd ? { cwd } : {}) },
    ) as Record<string, unknown> | null | undefined;
    const results: Array<Record<string, unknown>> =
      (result as { results?: Array<Record<string, unknown>> })?.results ?? [];
    return results.map((r) => ({
      // memory.retrieve returns the summary id embedded in `uri` /
      // `source_uri` as the trailing path segment, prefixed with `sum:` —
      // e.g. `synapse://<brain>/episode/sum:01ABC`. Extract and strip.
      summary_id: extractSummaryId(r),
      title: r.title as string,
      tags: (r.tags as string[]) ?? [],
      score: r.score as number | undefined,
    }));
  } catch (err) {
    console.error("[brain-sync] searchEpisodes failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// getExternalBlockers
// ---------------------------------------------------------------------------

/**
 * Snapshot of an external blocker attached to a brain task.
 * Mirrors the `external_blockers` array returned by `tasks.get`.
 */
export interface ExternalBlockerSnapshot {
  source: string;
  externalId: string;
  url?: string;
  taskId?: string;
  resolvedAt?: number; // unix seconds
}

/**
 * Consult the brain CLI for external blockers on a task (best-effort).
 *
 * On brain CLI failure the function returns `{ unresolvedCount: 0, blockers: [] }`
 * to ensure dispatch is never blocked by brain unavailability. The error is
 * logged to stderr for observability.
 */
export async function getExternalBlockers(
  taskId: string,
  brainExec: BrainExec,
): Promise<{ unresolvedCount: number; blockers: ExternalBlockerSnapshot[] }> {
  const empty = { unresolvedCount: 0, blockers: [] };
  try {
    const task = await callBrainTool(
      brainExec,
      "tasks.get",
      { task_id: taskId },
      { timeout: 5000 },
    ) as Record<string, unknown> | null | undefined;
    if (!task) return empty;
    const blockers: ExternalBlockerSnapshot[] = (
      (task.external_blockers as Array<Record<string, unknown>>) ?? []
    ).map((b) => ({
      source: b.source as string,
      externalId: b.externalId as string,
      ...(b.url !== undefined ? { url: b.url as string } : {}),
      ...(b.taskId !== undefined ? { taskId: b.taskId as string } : {}),
      ...(b.resolvedAt !== undefined
        ? { resolvedAt: b.resolvedAt as number }
        : {}),
    }));
    const unresolvedCount: number =
      typeof (task.dependency_summary as Record<string, unknown> | undefined)
          ?.external_blocker_unresolved_count === "number"
        ? (task.dependency_summary as Record<string, unknown>)
          .external_blocker_unresolved_count as number
        : blockers.filter((b) => b.resolvedAt === undefined).length;
    return { unresolvedCount, blockers };
  } catch (err) {
    console.error(
      `[brain-sync] getExternalBlockers failed for task ${taskId}:`,
      err,
    );
    return empty;
  }
}

// ---------------------------------------------------------------------------
// syncGraphDepsToBrain
// ---------------------------------------------------------------------------

/**
 * Project graph edges as brain task dependencies (best-effort, idempotent).
 * Only edges where both source and target have a `taskId` are synced.
 */
export async function syncGraphDepsToBrain(
  graph: Graph,
  cwd?: string,
  exec?: BrainExec,
): Promise<void> {
  if (!exec) return;
  const pairs: { task_id: string; depends_on_task_id: string }[] = [];
  for (const edge of graph.edges) {
    const source = graph.nodes[edge.from];
    const target = graph.nodes[edge.to];
    if (source?.taskId && target?.taskId) {
      pairs.push({
        task_id: target.taskId,
        depends_on_task_id: source.taskId,
      });
    }
  }
  if (pairs.length === 0) return;
  try {
    await callBrainTool(
      exec,
      "tasks.deps_batch",
      { action: "add", deps: pairs },
      { timeout: 5000, ...(cwd ? { cwd } : {}) },
    );
  } catch (err) {
    console.error("[brain-sync] syncGraphDepsToBrain failed:", err);
    // Best-effort — graph remains source of truth
  }
}
