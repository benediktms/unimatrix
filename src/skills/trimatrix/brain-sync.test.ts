// deno-lint-ignore-file require-await -- BrainExec mocks satisfy an async interface without awaiting

/**
 * Tests for brain-sync.ts — cwd-routing logic for brain CLI task syncing.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BrainError,
  callBrainTool,
  repoRoot,
  searchEpisodes,
  syncGraphDepsToBrain,
  syncTaskStatus,
  writeEpisode,
} from "./brain-sync.ts";
import type { BrainExec } from "./brain-sync.ts";
import type { Graph, RepoMetadata } from "./types.ts";
import { EdgeType, Executor, NodeStatus, NodeType } from "./types.ts";

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

function mockExec(opts?: { shouldThrow?: boolean; withStdinReturn?: string }): {
  exec: BrainExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: BrainExec = {
    async withStdin(cmd, args, stdinData, timeout, cwd) {
      calls.push({ method: "withStdin", cmd, args, stdinData, timeout, cwd });
      if (opts?.shouldThrow) throw new Error("exec failed");
      return opts?.withStdinReturn ?? "";
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

Deno.test("repoRoot: throws for unknown repo", () => {
  assertThrows(
    () => repoRoot(REPOS, "nonexistent"),
    Error,
    'Repo "nonexistent" not found in checkpoint',
  );
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
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "tasks.apply_event");
  assertEquals(payload.params.arguments.event.status, "in_progress");
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
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "tasks.apply_event");
  assertEquals(payload.params.arguments.event.status, "blocked");
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
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "tasks.apply_event");
  assertEquals(payload.params.arguments.task_id, "task-frontend-1");
});

// ---------------------------------------------------------------------------
// writeEpisode
// ---------------------------------------------------------------------------

Deno.test("writeEpisode: sends correct JSON-RPC payload", async () => {
  const response = JSON.stringify({
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ status: "stored", summary_id: "ep-123" }),
      }],
    },
  });
  const { exec, calls } = mockExec({ withStdinReturn: response });
  const result = await writeEpisode(
    "test goal",
    ["action1", "action2"],
    "success",
    ["tag1"],
    0.8,
    "/repo",
    exec,
  );
  assertEquals(result, "ep-123");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "withStdin");
  assertEquals(calls[0].cmd, "brain");
  assertEquals(calls[0].args, ["mcp"]);
  assertEquals(calls[0].cwd, "/repo");
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "memory.write_episode");
  assertEquals(payload.params.arguments.goal, "test goal");
  assertEquals(payload.params.arguments.actions, "action1\naction2");
  assertEquals(payload.params.arguments.outcome, "success");
  assertEquals(payload.params.arguments.tags, ["tag1"]);
  assertEquals(payload.params.arguments.importance, 0.8);
});

Deno.test("writeEpisode: returns null when no exec provided", async () => {
  const result = await writeEpisode("goal", ["a"], "ok", []);
  assertEquals(result, null);
});

Deno.test("writeEpisode: swallows errors and returns null", async () => {
  const { exec } = mockExec({ shouldThrow: true });
  const result = await writeEpisode(
    "goal",
    ["a"],
    "ok",
    [],
    undefined,
    undefined,
    exec,
  );
  assertEquals(result, null);
});

Deno.test("writeEpisode: returns null on unparseable response", async () => {
  const { exec } = mockExec({ withStdinReturn: "not json" });
  const result = await writeEpisode(
    "goal",
    ["a"],
    "ok",
    [],
    undefined,
    undefined,
    exec,
  );
  assertEquals(result, null);
});

Deno.test("writeEpisode: returns null when response lacks summary_id", async () => {
  const response = JSON.stringify({
    result: {
      content: [{ type: "text", text: JSON.stringify({ status: "stored" }) }],
    },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await writeEpisode(
    "goal",
    ["a"],
    "ok",
    [],
    undefined,
    undefined,
    exec,
  );
  assertEquals(result, null);
});

Deno.test("writeEpisode: omits importance when undefined", async () => {
  const response = JSON.stringify({
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ summary_id: "ep-456" }),
      }],
    },
  });
  const { exec, calls } = mockExec({ withStdinReturn: response });
  await writeEpisode("goal", [], "ok", [], undefined, undefined, exec);
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.params.arguments.importance, undefined);
});

// ---------------------------------------------------------------------------
// searchEpisodes
// ---------------------------------------------------------------------------

Deno.test("searchEpisodes: sends correct JSON-RPC envelope and maps results", async () => {
  // memory.retrieve filters by `kinds: ["episode"]` server-side; the function
  // trusts the server and does not re-filter client-side. The summary id is
  // extracted from the trailing `sum:<ulid>` segment of the response `uri`.
  const searchResult = {
    results: [
      {
        kind: "episode",
        uri: "synapse://test-brain/episode/sum:ep-1",
        title: "Wave 1",
        tags: ["trimatrix"],
        score: 0.9,
      },
      {
        kind: "episode",
        uri: "synapse://test-brain/episode/sum:ep-2",
        title: "Wave 2",
        tags: ["trimatrix"],
        score: 0.7,
      },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec, calls } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "test query",
    ["trimatrix"],
    ["all"],
    1000,
    "/repo",
    exec,
  );
  assertEquals(result.length, 2);
  assertEquals(result[0].summary_id, "ep-1");
  assertEquals(result[0].title, "Wave 1");
  assertEquals(result[1].summary_id, "ep-2");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].cwd, "/repo");
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "memory.retrieve");
  assertEquals(payload.params.arguments.query, "test query");
  assertEquals(payload.params.arguments.tags, ["trimatrix"]);
  assertEquals(payload.params.arguments.brains, ["all"]);
  // memory.retrieve takes `count` (not `budget_tokens`); budget→count: 1000/100 = 10.
  assertEquals(payload.params.arguments.count, 10);
  assertEquals(payload.params.arguments.kinds, ["episode"]);
  // budget_tokens must NOT be sent — memory.retrieve does not accept it.
  assertEquals(
    "budget_tokens" in payload.params.arguments,
    false,
    "budget_tokens must not be sent — memory.retrieve does not accept it",
  );
});

Deno.test("searchEpisodes: returns empty when no exec provided", async () => {
  const result = await searchEpisodes("query");
  assertEquals(result, []);
});

Deno.test("searchEpisodes: swallows errors and returns empty", async () => {
  const { exec } = mockExec({ shouldThrow: true });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result, []);
});

Deno.test("searchEpisodes: returns empty when brain returns empty results", async () => {
  // Note: kinds:["episode"] is enforced server-side; the function no longer
  // filters client-side. This test verifies the empty-pass-through behavior.
  const response = JSON.stringify({
    result: {
      content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
    },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result, []);
});

Deno.test("searchEpisodes: extracts summary_id from uri trailing segment, stripping sum: prefix", async () => {
  const searchResult = {
    results: [
      {
        kind: "episode",
        uri: "synapse://test-brain/episode/sum:01ABC",
        title: "Ep",
        tags: [],
        score: 0.9,
      },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result[0].summary_id, "01ABC");
});

Deno.test("searchEpisodes: falls back to source_uri when uri is absent", async () => {
  const searchResult = {
    results: [
      {
        kind: "episode",
        source_uri: "synapse://other-brain/episode/sum:fallback-ulid",
        title: "Ep",
        tags: [],
        score: 0.5,
      },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result[0].summary_id, "fallback-ulid");
});

Deno.test("searchEpisodes: returns empty summary_id when neither uri nor source_uri is present", async () => {
  const searchResult = {
    results: [
      { kind: "episode", title: "Ep", tags: [], score: 0.5 },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result[0].summary_id, "");
  assertEquals(result[0].title, "Ep");
});

Deno.test("searchEpisodes: returns empty summary_id when uri lacks /episode/sum: anchor", async () => {
  // Defensive: the helper anchors on `/episode/sum:` so a URI in an unexpected
  // shape (no episode segment, no sum: prefix, query/fragment-suffixed path)
  // returns "" rather than silently producing a garbage trailing-segment id.
  const searchResult = {
    results: [
      {
        kind: "episode",
        uri: "synapse://test-brain/some-other-shape/01ABC",
        title: "Ep",
        tags: [],
        score: 0.5,
      },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result[0].summary_id, "");
});

Deno.test("searchEpisodes: tolerates query/fragment suffixes on the episode uri", async () => {
  // The regex anchor `[^/?#]+` stops at `?` or `#`, so suffixed URIs still
  // produce the bare ulid rather than including the suffix.
  const searchResult = {
    results: [
      {
        kind: "episode",
        uri: "synapse://test-brain/episode/sum:01ABC?from=cache",
        title: "Ep",
        tags: [],
        score: 0.5,
      },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result[0].summary_id, "01ABC");
});

Deno.test("searchEpisodes: returns empty summary_id when uri value is non-string", async () => {
  // Brain currently always serializes uri as string; this defensive test pins
  // the contract so a regression on the brain side cannot produce
  // "[object Object]"-shaped ids.
  const searchResult = {
    results: [
      { kind: "episode", uri: 42, title: "Ep", tags: [], score: 0.5 },
    ],
  };
  const response = JSON.stringify({
    result: { content: [{ type: "text", text: JSON.stringify(searchResult) }] },
  });
  const { exec } = mockExec({ withStdinReturn: response });
  const result = await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  assertEquals(result[0].summary_id, "");
});

Deno.test("searchEpisodes: default budget of 800 maps to count of 8", async () => {
  const response = JSON.stringify({
    result: {
      content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
    },
  });
  const { exec, calls } = mockExec({ withStdinReturn: response });
  await searchEpisodes(
    "query",
    undefined,
    undefined,
    undefined,
    undefined,
    exec,
  );
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "memory.retrieve");
  assertEquals(payload.params.arguments.count, 8);
  assertEquals(payload.params.arguments.kinds, ["episode"]);
});

Deno.test("searchEpisodes: custom budget maps to count via budget/100 floor", async () => {
  const response = JSON.stringify({
    result: {
      content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
    },
  });
  // budget=50 → max(1, floor(50/100)) = max(1, 0) = 1
  const small = mockExec({ withStdinReturn: response });
  await searchEpisodes(
    "query",
    undefined,
    undefined,
    50,
    undefined,
    small.exec,
  );
  let payload = JSON.parse(small.calls[0].stdinData!);
  assertEquals(payload.params.arguments.count, 1);

  // budget=2500 → floor(2500/100) = 25
  const large = mockExec({ withStdinReturn: response });
  await searchEpisodes(
    "query",
    undefined,
    undefined,
    2500,
    undefined,
    large.exec,
  );
  payload = JSON.parse(large.calls[0].stdinData!);
  assertEquals(payload.params.arguments.count, 25);
});

// ---------------------------------------------------------------------------
// syncGraphDepsToBrain
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  overrides: Partial<Graph["nodes"][string]> = {},
): Graph["nodes"][string] {
  return {
    id,
    type: NodeType.IMPLEMENTATION,
    label: id,
    status: NodeStatus.PENDING,
    executor: Executor.LEAD,
    worktreeBranch: `trimatrix/${id}`,
    ...overrides,
  };
}

Deno.test("syncGraphDepsToBrain: calls tasks_deps_batch with correct pairs", async () => {
  const graph: Graph = {
    nodes: {
      A: makeNode("A", { taskId: "t-A" }),
      B: makeNode("B", { taskId: "t-B" }),
      C: makeNode("C", { taskId: "t-C" }),
    },
    edges: [
      { from: "A", to: "B", type: EdgeType.DEPENDS_ON },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  };
  const { exec, calls } = mockExec();
  await syncGraphDepsToBrain(graph, "/repo", exec);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "withStdin");
  assertEquals(calls[0].cwd, "/repo");
  const payload = JSON.parse(calls[0].stdinData!);
  assertEquals(payload.method, "tools/call");
  assertEquals(payload.params.name, "tasks.deps_batch");
  assertEquals(payload.params.arguments.action, "add");
  assertEquals(payload.params.arguments.deps.length, 2);
  assertEquals(payload.params.arguments.deps[0], {
    task_id: "t-B",
    depends_on_task_id: "t-A",
  });
  assertEquals(payload.params.arguments.deps[1], {
    task_id: "t-C",
    depends_on_task_id: "t-B",
  });
});

Deno.test("syncGraphDepsToBrain: skips edges where source/target lacks taskId", async () => {
  const graph: Graph = {
    nodes: {
      A: makeNode("A", { taskId: "t-A" }),
      B: makeNode("B"), // no taskId
      C: makeNode("C", { taskId: "t-C" }),
    },
    edges: [
      { from: "A", to: "B", type: EdgeType.DEPENDS_ON },
      { from: "B", to: "C", type: EdgeType.MERGE_GATE },
    ],
  };
  const { exec, calls } = mockExec();
  await syncGraphDepsToBrain(graph, undefined, exec);
  assertEquals(calls.length, 0); // no pairs with both taskIds
});

Deno.test("syncGraphDepsToBrain: no-ops when exec is undefined", async () => {
  const graph: Graph = {
    nodes: {
      A: makeNode("A", { taskId: "t-A" }),
      B: makeNode("B", { taskId: "t-B" }),
    },
    edges: [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  };
  // Must not throw
  await syncGraphDepsToBrain(graph);
});

Deno.test("syncGraphDepsToBrain: handles exec failure gracefully", async () => {
  const graph: Graph = {
    nodes: {
      A: makeNode("A", { taskId: "t-A" }),
      B: makeNode("B", { taskId: "t-B" }),
    },
    edges: [{ from: "A", to: "B", type: EdgeType.DEPENDS_ON }],
  };
  const { exec } = mockExec({ shouldThrow: true });
  // Must not throw
  await syncGraphDepsToBrain(graph, undefined, exec);
});

// ---------------------------------------------------------------------------
// callBrainTool: BrainError propagation and transport/parse failure paths
// ---------------------------------------------------------------------------

Deno.test("callBrainTool: throws BrainError with code and message when brain returns error payload", async () => {
  const exec: BrainExec = {
    withStdin: async (_cmd, _args, stdin) => {
      const req = JSON.parse(stdin ?? "{}");
      return JSON.stringify({
        jsonrpc: "2.0",
        id: req.id ?? 1,
        error: { code: -32603, message: "internal brain error" },
      });
    },
    exec: async () => ({ stdout: "", stderr: "" }),
  };

  await assertRejects(
    async () => {
      await callBrainTool(exec, "tasks.get", { task_id: "t-1" });
    },
    BrainError,
    "internal brain error",
  );

  // Also verify the code is propagated
  try {
    await callBrainTool(exec, "tasks.get", { task_id: "t-1" });
  } catch (err) {
    assertEquals(err instanceof BrainError, true);
    assertEquals((err as BrainError).code, -32603);
    assertEquals((err as BrainError).name, "BrainError");
  }
});

Deno.test("callBrainTool: wraps outer-parse failure as BrainError with cause", async () => {
  const exec: BrainExec = {
    withStdin: async () => "not valid json {{{{",
    exec: async () => ({ stdout: "", stderr: "" }),
  };

  await assertRejects(
    async () => {
      await callBrainTool(exec, "tasks.get", { task_id: "t-2" });
    },
    BrainError,
    "malformed JSON envelope",
  );

  // Verify the underlying SyntaxError is preserved as `cause`.
  try {
    await callBrainTool(exec, "tasks.get", { task_id: "t-2" });
  } catch (err) {
    assertEquals(err instanceof BrainError, true);
    assertEquals((err as BrainError).cause instanceof SyntaxError, true);
  }
});

Deno.test("callBrainTool: wraps inner-parse failure as BrainError with cause", async () => {
  // Outer envelope parses fine, but result.content[0].text is invalid JSON.
  const exec: BrainExec = {
    withStdin: async () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "not valid json {{{" }] },
      }),
    exec: async () => ({ stdout: "", stderr: "" }),
  };

  await assertRejects(
    async () => {
      await callBrainTool(exec, "tasks.get", { task_id: "t-3" });
    },
    BrainError,
    "malformed JSON content",
  );

  try {
    await callBrainTool(exec, "tasks.get", { task_id: "t-3" });
  } catch (err) {
    assertEquals(err instanceof BrainError, true);
    assertEquals((err as BrainError).cause instanceof SyntaxError, true);
  }
});
