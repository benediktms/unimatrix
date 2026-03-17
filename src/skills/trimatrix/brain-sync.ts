/**
 * Brain CLI interaction layer for task status syncing.
 *
 * Extracted from server.ts to enable unit testing of the cwd-routing logic
 * without a running brain CLI or MCP server.
 */

import type { RepoMetadata } from "./types.ts";

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
  return repos.find((r) => r.name === repoName)?.root;
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
