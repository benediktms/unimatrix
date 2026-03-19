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
      const eventJson = JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks_apply_event",
        params: {
          task_id: taskId,
          event: { type: "status_changed", status: newStatus },
        },
        id: 1,
      });
      await exec.withStdin(BRAIN_CLI, ["mcp"], eventJson, 5000, cwd);
    }
  } catch {
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
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      method: "memory_write_episode",
      params: {
        goal,
        actions: actions.join("\n"),
        outcome,
        tags,
        ...(importance !== undefined ? { importance } : {}),
      },
      id: 1,
    });
    const raw = await exec.withStdin(BRAIN_CLI, ["mcp"], rpc, 5000, cwd);
    const parsed = JSON.parse(raw);
    const content = parsed?.result?.content?.[0]?.text;
    if (content) {
      const result = JSON.parse(content);
      return result.summary_id ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// searchEpisodes
// ---------------------------------------------------------------------------

/**
 * Search brain's episodic memory for prior episodes (best-effort).
 * Returns matching episode stubs, or empty array on failure.
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
  try {
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      method: "memory_search_minimal",
      params: {
        query,
        budget_tokens: budget ?? 800,
        ...(tags ? { tags } : {}),
        ...(brains ? { brains } : {}),
      },
      id: 1,
    });
    const raw = await exec.withStdin(BRAIN_CLI, ["mcp"], rpc, 5000, cwd);
    const parsed = JSON.parse(raw);
    const content = parsed?.result?.content?.[0]?.text;
    if (content) {
      const result = JSON.parse(content);
      const results: Array<Record<string, unknown>> = result.results ?? [];
      return results
        .filter((r) => r.kind === "episode")
        .map((r) => ({
          // memory_id uses format "sum:{ulid}" — strip prefix for bare summary_id
          summary_id: String(r.memory_id ?? "").replace(/^sum:/, ""),
          title: r.title as string,
          tags: (r.tags as string[]) ?? [],
          score: r.score as number | undefined,
        }));
    }
    return [];
  } catch {
    return [];
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
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks_deps_batch",
      params: { action: "add", deps: pairs },
      id: 1,
    });
    await exec.withStdin(BRAIN_CLI, ["mcp"], rpc, 5000, cwd);
  } catch {
    // Best-effort — graph remains source of truth
  }
}
