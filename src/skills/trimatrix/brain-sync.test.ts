/**
 * Tests for brain-sync.ts — cwd-routing logic for brain CLI task syncing.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { repoRoot, syncTaskStatus } from "./brain-sync.ts";
import type { BrainExec } from "./brain-sync.ts";
import type { RepoMetadata } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock executor
// ---------------------------------------------------------------------------

interface ExecCall {
  method: "withStdin" | "exec";
  cmd: string;
  args: string[];
  stdinData?: string;
  timeout?: number;
  cwd?: string;
}

function mockExec(opts?: { shouldThrow?: boolean }): {
  exec: BrainExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: BrainExec = {
    async withStdin(cmd, args, stdinData, timeout, cwd) {
      calls.push({ method: "withStdin", cmd, args, stdinData, timeout, cwd });
      if (opts?.shouldThrow) throw new Error("exec failed");
      return "";
    },
    async exec(cmd, args, execOpts) {
      calls.push({
        method: "exec",
        cmd,
        args,
        timeout: execOpts?.timeout,
        cwd: execOpts?.cwd,
      });
      if (opts?.shouldThrow) throw new Error("exec failed");
      return { stdout: "", stderr: "" };
    },
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Fixture repos
// ---------------------------------------------------------------------------

const REPOS: RepoMetadata[] = [
  { name: "api", root: "/home/user/code/api", worktrees: [] },
  { name: "web", root: "/home/user/code/web", worktrees: [] },
];

// ---------------------------------------------------------------------------
// repoRoot
// ---------------------------------------------------------------------------

Deno.test("repoRoot: resolves known repo", () => {
  assertEquals(repoRoot(REPOS, "api"), "/home/user/code/api");
  assertEquals(repoRoot(REPOS, "web"), "/home/user/code/web");
});

Deno.test("repoRoot: returns undefined for unknown repo", () => {
  assertEquals(repoRoot(REPOS, "nonexistent"), undefined);
});

Deno.test("repoRoot: returns undefined for undefined repoName", () => {
  assertEquals(repoRoot(REPOS, undefined), undefined);
});

Deno.test("repoRoot: returns undefined for empty repos array", () => {
  assertEquals(repoRoot([], "api"), undefined);
});

// ---------------------------------------------------------------------------
// syncTaskStatus
// ---------------------------------------------------------------------------

Deno.test("syncTaskStatus activate: passes cwd to exec", async () => {
  const { exec, calls } = mockExec();
  await syncTaskStatus("task-1", "activate", "/repo/root", exec);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "withStdin");
  assertEquals(calls[0].cwd, "/repo/root");
  assertEquals(calls[0].cmd, "brain");
  assertEquals(calls[0].args, ["mcp"]);
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.params.event.status, "in_progress");
});

Deno.test("syncTaskStatus close: passes cwd to exec", async () => {
  const { exec, calls } = mockExec();
  await syncTaskStatus("task-2", "close", "/repo/root", exec);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "exec");
  assertEquals(calls[0].cwd, "/repo/root");
  assertEquals(calls[0].args, ["tasks", "close", "task-2"]);
});

Deno.test("syncTaskStatus block: passes cwd to exec", async () => {
  const { exec, calls } = mockExec();
  await syncTaskStatus("task-3", "block", "/repo/root", exec);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "withStdin");
  assertEquals(calls[0].cwd, "/repo/root");
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.params.event.status, "blocked");
});

Deno.test("syncTaskStatus: omits cwd when undefined", async () => {
  const { exec, calls } = mockExec();
  await syncTaskStatus("task-4", "activate", undefined, exec);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].cwd, undefined);
});

Deno.test("syncTaskStatus: swallows errors", async () => {
  const { exec } = mockExec({ shouldThrow: true });
  // Must not throw
  await syncTaskStatus("task-5", "activate", "/repo/root", exec);
});

// ---------------------------------------------------------------------------
// Integration: node.repo → repoRoot → syncTaskStatus cwd
// ---------------------------------------------------------------------------

Deno.test("Integration: node.repo → repoRoot → syncTaskStatus cwd", async () => {
  const repos: RepoMetadata[] = [
    { name: "backend", root: "/workspace/backend", worktrees: [] },
    { name: "frontend", root: "/workspace/frontend", worktrees: [] },
  ];

  // Simulate a node with repo: "frontend"
  const node = { taskId: "task-frontend-1", repo: "frontend" };

  const cwd = repoRoot(repos, node.repo);
  assertEquals(cwd, "/workspace/frontend");

  const { exec, calls } = mockExec();
  await syncTaskStatus(node.taskId, "activate", cwd, exec);
  assertEquals(calls[0].cwd, "/workspace/frontend");
  assertEquals(calls[0].cmd, "brain");

  // Verify the full JSON-RPC payload targets the correct task
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.params.task_id, "task-frontend-1");
});
