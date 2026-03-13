/**
 * borgcube MCP server — exposes graph and state machine operations as MCP tools.
 *
 * Holds ONE checkpoint in memory. Tools require the checkpoint to be initialized
 * before use (via `init` or `restore_checkpoint`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { Checkpoint, RepoMetadata } from "./types.ts";
import {
  activateNodes,
  clearGate,
  completeNode,
  computeWaves,
  failNode,
  nextWave,
  validate,
  waveStatus,
} from "./graph.ts";
import {
  canTransition,
  createCheckpoint,
  deserialize,
  serialize,
  transition,
} from "./state.ts";

// ---------------------------------------------------------------------------
// In-memory checkpoint store
// ---------------------------------------------------------------------------

let checkpoint: Checkpoint | null = null;

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

function requireCheckpoint(): Checkpoint {
  if (checkpoint === null) {
    throw new Error(
      "No checkpoint loaded. Call init or restore_checkpoint first.",
    );
  }
  return checkpoint;
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "borgcube",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: init
// ---------------------------------------------------------------------------

server.tool(
  "init",
  "Initialize borgcube with repository metadata. Creates an empty graph and checkpoint in initializing state.",
  {
    repos: z.array(
      z.object({
        name: z.string(),
        root: z.string(),
        worktrees: z.array(
          z.object({
            branch: z.string(),
            path: z.string().optional(),
            stackedOn: z.string().optional(),
            nodeId: z.string(),
          }),
        ),
      }),
    ).describe("Repository metadata for this execution"),
  },
  (params) => {
    const repos = params.repos as RepoMetadata[];
    const emptyGraph = { nodes: {}, edges: [] };
    checkpoint = createCheckpoint(repos, emptyGraph);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            repos: checkpoint.repos.map((r) => r.name),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_repo
// ---------------------------------------------------------------------------

server.tool(
  "add_repo",
  "Add a repository to the current checkpoint. Use when expanding scope on resume. No-op if the repo already exists.",
  {
    name: z.string().describe("Brain name or ref for the repository"),
    root: z.string().describe("Resolved root path of the repository"),
    worktrees: z.array(
      z.object({
        branch: z.string(),
        path: z.string().optional(),
        stackedOn: z.string().optional(),
        nodeId: z.string(),
      }),
    ).optional().describe("Worktree metadata (can be added later via add_node)"),
  },
  (params) => {
    const cp = requireCheckpoint();

    const existing = cp.repos.find((r) => r.name === params.name);
    if (existing) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            added: false,
            message: `Repo '${params.name}' already exists.`,
          }),
        }],
      };
    }

    const repo: RepoMetadata = {
      name: params.name,
      root: params.root,
      worktrees: (params.worktrees ?? []) as RepoMetadata["worktrees"],
    };
    checkpoint = {
      ...cp,
      repos: [...cp.repos, repo],
      updatedAt: new Date().toISOString(),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          added: true,
          repos: checkpoint!.repos.map((r) => r.name),
        }),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_node
// ---------------------------------------------------------------------------

server.tool(
  "add_node",
  "Add a node to the execution graph.",
  {
    id: z.string().describe("Unique node identifier"),
    repo: z.string().describe("Brain name or ref for the target repository"),
    type: z.enum(["contract", "implementation"]).describe("Node type"),
    label: z.string().describe("Human-readable description"),
    worktreeBranch: z.string().describe("Worktree branch name for this node"),
    stackedOn: z.string().optional().describe(
      "Node ID this node is stacked on within the same repository",
    ),
  },
  (params) => {
    const cp = requireCheckpoint();
    const node = {
      id: params.id,
      repo: params.repo,
      type: params.type as "contract" | "implementation",
      label: params.label,
      worktreeBranch: params.worktreeBranch,
      ...(params.stackedOn !== undefined
        ? { stackedOn: params.stackedOn }
        : {}),
      status: "pending" as const,
    };
    checkpoint = {
      ...cp,
      graph: {
        ...cp.graph,
        nodes: { ...cp.graph.nodes, [params.id]: node },
      },
      updatedAt: new Date().toISOString(),
    };
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, id: params.id }),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_edge
// ---------------------------------------------------------------------------

server.tool(
  "add_edge",
  "Add a directed dependency edge between two nodes.",
  {
    from: z.string().describe("Source node ID"),
    to: z.string().describe("Target node ID"),
    type: z.enum(["merge_gate", "stacked"]).describe("Edge type"),
  },
  (params) => {
    const cp = requireCheckpoint();
    const edge = {
      from: params.from,
      to: params.to,
      type: params.type as "merge_gate" | "stacked",
    };
    checkpoint = {
      ...cp,
      graph: {
        ...cp.graph,
        edges: [...cp.graph.edges, edge],
      },
      updatedAt: new Date().toISOString(),
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, from: params.from, to: params.to }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: validate
// ---------------------------------------------------------------------------

server.tool(
  "validate",
  "Validate graph integrity — checks edge refs, stackedOn refs, and cycles.",
  {},
  () => {
    const cp = requireCheckpoint();
    const result = validate(cp.graph);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: compute_waves
// ---------------------------------------------------------------------------

server.tool(
  "compute_waves",
  "Validate graph, compute execution waves, and transition to dispatching state (plan_approved).",
  {},
  () => {
    const cp = requireCheckpoint();

    const validationResult = validate(cp.graph);
    if (!validationResult.valid) {
      throw new Error(
        `Graph validation failed: ${validationResult.errors.join("; ")}`,
      );
    }

    const check = canTransition(cp, { type: "plan_approved" });
    if (!check.allowed) {
      throw new Error(`Cannot transition: ${check.reason}`);
    }

    const waves = computeWaves(cp.graph);
    const transitioned = transition(
      { ...cp, waves },
      { type: "plan_approved" },
    );
    checkpoint = transitioned;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            waves: checkpoint.waves,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: dispatch_wave
// ---------------------------------------------------------------------------

server.tool(
  "dispatch_wave",
  "Activate all nodes in the specified wave and record it as the current wave.",
  {
    waveId: z.number().int().describe("Wave index to dispatch"),
  },
  (params) => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, {
      type: "wave_dispatched",
      waveId: params.waveId,
    });
    if (!check.allowed) {
      throw new Error(`Cannot dispatch wave: ${check.reason}`);
    }

    const wave = cp.waves.find((w) => w.id === params.waveId);
    if (!wave) {
      throw new Error(`Wave ${params.waveId} not found`);
    }

    const activatedGraph = activateNodes(cp.graph, wave.nodes);
    const transitioned = transition(
      { ...cp, graph: activatedGraph },
      { type: "wave_dispatched", waveId: params.waveId },
    );
    checkpoint = transitioned;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            waveId: params.waveId,
            activatedNodes: wave.nodes,
            machineState: checkpoint.machineState,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: complete_node
// ---------------------------------------------------------------------------

server.tool(
  "complete_node",
  "Mark a node as completed. Provide prUrl and prNumber to record a PR; omit to mark as merged directly.",
  {
    nodeId: z.string().describe("Node ID to complete"),
    prUrl: z.string().optional().describe("URL of the pull request, if any"),
    prNumber: z.number().int().optional().describe(
      "Pull request number, if any",
    ),
  },
  (params) => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, {
      type: "node_completed",
      nodeId: params.nodeId,
      prUrl: params.prUrl,
      prNumber: params.prNumber,
    });
    if (!check.allowed) {
      throw new Error(`Cannot complete node: ${check.reason}`);
    }

    const pr = params.prUrl !== undefined && params.prNumber !== undefined
      ? { url: params.prUrl, number: params.prNumber }
      : undefined;

    const updatedGraph = completeNode(cp.graph, params.nodeId, pr);
    const transitioned = transition(
      { ...cp, graph: updatedGraph },
      {
        type: "node_completed",
        nodeId: params.nodeId,
        prUrl: params.prUrl,
        prNumber: params.prNumber,
      },
    );
    checkpoint = transitioned;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            status: checkpoint.graph.nodes[params.nodeId]?.status,
            machineState: checkpoint.machineState,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: fail_node
// ---------------------------------------------------------------------------

server.tool(
  "fail_node",
  "Mark a node as failed with a human-readable reason.",
  {
    nodeId: z.string().describe("Node ID to fail"),
    reason: z.string().describe("Human-readable failure reason"),
  },
  (params) => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, {
      type: "node_failed",
      nodeId: params.nodeId,
      reason: params.reason,
    });
    if (!check.allowed) {
      throw new Error(`Cannot fail node: ${check.reason}`);
    }

    const updatedGraph = failNode(cp.graph, params.nodeId, params.reason);
    const transitioned = transition(
      { ...cp, graph: updatedGraph },
      { type: "node_failed", nodeId: params.nodeId, reason: params.reason },
    );
    checkpoint = transitioned;

    // Check if wave is now fully failed
    const wave = cp.waves.find((w) => w.id === cp.currentWaveId);
    if (wave) {
      const ws = waveStatus(checkpoint.graph, wave);
      if (ws === "failed" || ws === "partial_failure") {
        const waveCheck = canTransition(checkpoint, {
          type: "wave_failed",
          waveId: wave.id,
        });
        if (waveCheck.allowed) {
          checkpoint = transition(checkpoint, {
            type: "wave_failed",
            waveId: wave.id,
          });
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            status: checkpoint.graph.nodes[params.nodeId]?.status,
            machineState: checkpoint.machineState,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: clear_gate
// ---------------------------------------------------------------------------

server.tool(
  "clear_gate",
  "Clear the merge gate on a node. Auto-advances to dispatching state if all gates in the current wave are cleared.",
  {
    nodeId: z.string().describe("Node ID to clear gate for"),
  },
  (params) => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, {
      type: "gate_cleared",
      nodeId: params.nodeId,
    });
    if (!check.allowed) {
      throw new Error(`Cannot clear gate: ${check.reason}`);
    }

    // Apply gate_cleared via state machine (handles auto-advance internally)
    const transitioned = transition(cp, {
      type: "gate_cleared",
      nodeId: params.nodeId,
    });

    // Also update the graph via the pure graph helper (state.ts handles it inline,
    // but we call clearGate to keep graph consistent with the helper contract)
    const updatedGraph = clearGate(transitioned.graph, params.nodeId);
    checkpoint = { ...transitioned, graph: updatedGraph };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            machineState: checkpoint.machineState,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: next_wave
// ---------------------------------------------------------------------------

server.tool(
  "next_wave",
  "Return the next wave ready for execution, or null with a reason if none is available.",
  {},
  () => {
    const cp = requireCheckpoint();

    if (cp.machineState === "gate_halted") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave: null,
              reason:
                "Machine is gate_halted. Clear all merge gates before proceeding.",
            }),
          },
        ],
      };
    }

    if (cp.machineState === "completed") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave: null,
              reason: "Execution completed.",
            }),
          },
        ],
      };
    }

    if (cp.machineState === "failed") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave: null,
              reason: "Execution failed. Retry or inspect failed nodes.",
            }),
          },
        ],
      };
    }

    const wave = nextWave(cp.graph, cp.waves, cp.currentWaveId);
    if (wave === null) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave: null,
              reason: "No wave is ready. Dependencies may not be satisfied.",
            }),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ wave }) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: status
// ---------------------------------------------------------------------------

server.tool(
  "status",
  "Return full state summary including machine state, current wave, node statuses, and wave history. Returns idle state if no checkpoint is loaded.",
  {},
  () => {
    if (checkpoint === null) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ machineState: "idle" }),
          },
        ],
      };
    }

    const cp = checkpoint;

    const nodeStatuses = Object.fromEntries(
      Object.entries(cp.graph.nodes).map(([id, node]) => [
        id,
        {
          status: node.status,
          repo: node.repo,
          label: node.label,
          type: node.type,
          prUrl: node.prUrl,
          prNumber: node.prNumber,
          failureReason: node.failureReason,
        },
      ]),
    );

    const waveStatuses = cp.waves.map((w) => ({
      id: w.id,
      nodes: w.nodes,
      hasMergeGate: w.hasMergeGate,
      status: waveStatus(cp.graph, w),
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            machineState: cp.machineState,
            currentWaveId: cp.currentWaveId,
            repos: cp.repos.map((r) => r.name),
            nodes: nodeStatuses,
            waves: waveStatuses,
            waveHistory: cp.waveHistory,
            createdAt: cp.createdAt,
            updatedAt: cp.updatedAt,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: save_checkpoint
// ---------------------------------------------------------------------------

server.tool(
  "save_checkpoint",
  "Serialize the current checkpoint to a JSON string for persistence.",
  {},
  () => {
    const cp = requireCheckpoint();
    const json = serialize(cp);
    return {
      content: [{ type: "text", text: JSON.stringify({ checkpoint: json }) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: restore_checkpoint
// ---------------------------------------------------------------------------

server.tool(
  "restore_checkpoint",
  "Deserialize a previously saved checkpoint JSON string and load it into memory.",
  {
    checkpoint: z.string().describe("JSON string of a serialized checkpoint"),
  },
  (params) => {
    const cp = deserialize(params.checkpoint);
    checkpoint = cp;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            nodeCount: Object.keys(checkpoint.graph.nodes).length,
            waveCount: checkpoint.waves.length,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
