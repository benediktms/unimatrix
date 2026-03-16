/**
 * trimatrix MCP server — exposes graph and state machine operations as MCP tools.
 *
 * Holds ONE checkpoint in memory. Tools require the checkpoint to be initialized
 * before use (via `init` or `restore_checkpoint`).
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

import type {
  Checkpoint,
  ElicitationRequestedSchema,
  ElicitResult,
  RepoMetadata,
} from "./types.ts";
import { MachineState, approvalSchema, triageSchema } from "./types.ts";
import { designate, type Role } from "./designate.ts";
import {
  activateNodes,
  addEdge,
  addNode,
  clearGate,
  completeNode,
  computeWaves,
  computeWavesFromRefinement,
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
// Session helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const hash = Math.random().toString(36).slice(2, 6);
  return `trimatrix-${date}-${hash}`;
}

function generateSessionLabel(repos: RepoMetadata[]): string {
  return repos.map((r) => r.name).join(", ");
}

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

const mcp = new McpServer({
  name: "trimatrix",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Elicitation helper
// ---------------------------------------------------------------------------

/**
 * Request user input via MCP elicitation (form mode).
 *
 * Checks whether the connected client advertises elicitation capability.
 * If capable, sends an elicitation/create request and returns the result.
 * If the client lacks elicitation capability, returns `{ action: 'decline' }`
 * so callers can treat it as a graceful opt-out.
 */
export async function elicitForm(
  message: string,
  requestedSchema: ElicitationRequestedSchema,
): Promise<ElicitResult> {
  const capabilities = mcp.server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    return { action: "decline" };
  }
  // Our ElicitationRequestedSchema is a structural subset of the SDK's
  // requestedSchema. Cast to the parameter type via Parameters<> to avoid
  // importing the SDK types.js entry directly.
  type ElicitInputParams = Parameters<typeof mcp.server.elicitInput>[0];
  const raw = await mcp.server.elicitInput({
    message,
    requestedSchema,
  } as ElicitInputParams);
  if (raw.action === "accept") {
    return { action: "accept", content: raw.content ?? {} };
  }
  return { action: raw.action };
}

// ---------------------------------------------------------------------------
// Tool: init
// ---------------------------------------------------------------------------

const initSchema = z.object({
  repos: z
    .array(
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
    )
    .describe("Repository metadata for this execution"),
  sessionLabel: z
    .string()
    .optional()
    .describe("Human-readable session label. Auto-generated if omitted."),
});

mcp.registerTool(
  "init",
  {
    title: "Initialize Trimatrix protocol",
    description:
      "Initialize trimatrix with repository metadata. Creates an empty graph and checkpoint in initializing state.",
    inputSchema: initSchema.shape,
  },
  (params: z.infer<typeof initSchema>) => {
    const repos = params.repos as RepoMetadata[];
    const emptyGraph = { nodes: {}, edges: [] };
    const sessionId = generateSessionId();
    const sessionLabel = params.sessionLabel ?? generateSessionLabel(repos);
    checkpoint = createCheckpoint(repos, emptyGraph, {
      sessionId,
      sessionLabel,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            repos: checkpoint.repos.map((r) => r.name),
            sessionId,
            sessionLabel,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_repo
// ---------------------------------------------------------------------------

const addRepoSchema = z.object({
  name: z.string().describe("Brain name or ref for the repository"),
  root: z.string().describe("Resolved root path of the repository"),
  worktrees: z
    .array(
      z.object({
        branch: z.string(),
        path: z.string().optional(),
        stackedOn: z.string().optional(),
        nodeId: z.string(),
      }),
    )
    .optional()
    .describe("Worktree metadata (can be added later via add_node)"),
});

mcp.registerTool(
  "add_repo",
  {
    title: "Add repository",
    description:
      "Add a repository to the current checkpoint. Use when expanding scope on resume. No-op if the repo already exists.",
    inputSchema: addRepoSchema.shape,
  },
  (params: z.infer<typeof addRepoSchema>) => {
    const cp = requireCheckpoint();

    if (
      cp.machineState !== MachineState.INITIALIZING &&
      cp.machineState !== MachineState.REFINING
    ) {
      throw new Error(
        `add_repo requires initializing or refining state, got ${cp.machineState}`,
      );
    }

    const existing = cp.repos.find((r) => r.name === params.name);
    if (existing) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              added: false,
              message: `Repo '${params.name}' already exists.`,
            }),
          },
        ],
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
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            added: true,
            repos: checkpoint!.repos.map((r) => r.name),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_node
// ---------------------------------------------------------------------------

const addNodeSchema = z.object({
  id: z.string().describe("Unique node identifier"),
  repo: z.string().describe("Brain name or ref for the target repository"),
  type: z.enum(["contract", "implementation"]).describe("Node type"),
  label: z.string().describe("Human-readable description"),
  worktreeBranch: z.string().describe("Worktree branch name for this node"),
  stackedOn: z
    .string()
    .optional()
    .describe("Node ID this node is stacked on within the same repository"),
});

mcp.registerTool(
  "add_node",
  {
    title: "Add node",
    description: "Add a node to the execution graph.",
    inputSchema: addNodeSchema.shape,
  },
  (params: z.infer<typeof addNodeSchema>) => {
    const cp = requireCheckpoint();

    if (
      cp.machineState !== MachineState.INITIALIZING &&
      cp.machineState !== MachineState.REFINING
    ) {
      throw new Error(
        `add_node requires initializing or refining state, got ${cp.machineState}`,
      );
    }

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

    const result = addNode(
      cp.graph,
      node,
      cp.machineState === MachineState.REFINING,
    );
    if (!result.ok) {
      throw new Error(result.error);
    }

    checkpoint = {
      ...cp,
      graph: result.value!,
      updatedAt: new Date().toISOString(),
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, id: params.id }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_edge
// ---------------------------------------------------------------------------

const addEdgeSchema = z.object({
  from: z.string().describe("Source node ID"),
  to: z.string().describe("Target node ID"),
  type: z.enum(["merge_gate", "stacked"]).describe("Edge type"),
});

mcp.registerTool(
  "add_edge",
  {
    title: "Add edge",
    description: "Add a directed dependency edge between two nodes.",
    inputSchema: addEdgeSchema.shape,
  },
  (params: z.infer<typeof addEdgeSchema>) => {
    const cp = requireCheckpoint();

    if (
      cp.machineState !== MachineState.INITIALIZING &&
      cp.machineState !== MachineState.REFINING
    ) {
      throw new Error(
        `add_edge requires initializing or refining state, got ${cp.machineState}`,
      );
    }

    const edge = {
      from: params.from,
      to: params.to,
      type: params.type as "merge_gate" | "stacked",
    };

    const result = addEdge(
      cp.graph,
      edge,
      cp.machineState === MachineState.REFINING,
    );
    if (!result.ok) {
      throw new Error(result.error);
    }

    checkpoint = {
      ...cp,
      graph: result.value!,
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
// Tool: refine
// ---------------------------------------------------------------------------

mcp.registerTool(
  "refine",
  {
    title: "Refine",
    description:
      "Enter refining state to add new nodes, edges, or repos to an in-progress execution. Call compute_waves when done to apply the changes and resume dispatching.",
    inputSchema: {},
  },
  () => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, { type: "refine" });
    if (!check.allowed) {
      throw new Error(`Cannot enter refining state: ${check.reason}`);
    }

    const transitioned = transition(cp, { type: "refine" });
    checkpoint = transitioned;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            currentWaveId: checkpoint.currentWaveId,
            nodeCount: Object.keys(checkpoint.graph.nodes).length,
            waveCount: checkpoint.waves.length,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: validate
// ---------------------------------------------------------------------------

mcp.registerTool(
  "validate",
  {
    title: "Validate graph",
    description:
      "Validate graph integrity — checks edge refs, stackedOn refs, and cycles.",
    inputSchema: {},
  },
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

mcp.registerTool(
  "compute_waves",
  {
    title: "Compute Execution Waves",
    description:
      "Validate graph, compute execution waves, and transition to dispatching state. In refining state uses partial recomputation (refinement_approved); in initializing state uses full computation (plan_approved).",
    inputSchema: {},
  },
  async () => {
    const cp = requireCheckpoint();

    const validationResult = validate(cp.graph);
    if (!validationResult.valid) {
      throw new Error(
        `Graph validation failed: ${validationResult.errors.join("; ")}`,
      );
    }

    if (cp.machineState === MachineState.REFINING) {
      // Partial recomputation — preserve completed waves, append new waves
      const check = canTransition(cp, { type: "refinement_approved" });
      if (!check.allowed) {
        throw new Error(`Cannot transition: ${check.reason}`);
      }

      // Determine the last completed wave number to offset new wave IDs
      const completedWaves = cp.waves.filter((w) =>
        w.nodes.every((nId) => cp.graph.nodes[nId]?.status === "merged"),
      );
      const waveOffset =
        completedWaves.length > 0
          ? Math.max(...completedWaves.map((w) => w.id))
          : 0;

      const newWaves = computeWavesFromRefinement(cp.graph, waveOffset);

      // Merge: keep completed waves, replace remaining with recomputed waves
      const mergedWaves = [...completedWaves, ...newWaves];

      // Collect what was added in this refinement for the history record
      const existingNodeIds = new Set(cp.waves.flatMap((w) => w.nodes));
      const addedNodes = Object.keys(cp.graph.nodes).filter(
        (id) => !existingNodeIds.has(id),
      );

      // Record all edges pointing to or from new nodes
      const addedEdges = cp.graph.edges
        .filter((e) => addedNodes.includes(e.from) || addedNodes.includes(e.to))
        .map((e) => ({ from: e.from, to: e.to, type: e.type }));

      // Repos referenced by pre-refinement wave nodes (existing scope)
      const preRefinementRepoNames = new Set(
        cp.waves.flatMap((w) =>
          w.nodes.map((nId) => cp.graph.nodes[nId]?.repo).filter(Boolean),
        ),
      );
      const addedRepos = cp.repos
        .map((r) => r.name)
        .filter((name) => !preRefinementRepoNames.has(name));

      // Build elicitation message summarising the proposed changes
      const completedWavesSummary =
        completedWaves.length > 0
          ? `Completed waves (read-only): ${completedWaves.map((w) => `Wave ${w.id}`).join(", ")}`
          : "No completed waves.";

      const revisedWavesSummary =
        newWaves.length > 0
          ? `Revised future waves (${newWaves.length}): ${newWaves
              .map(
                (w) =>
                  `Wave ${w.id} — ${w.nodes.length} node${w.nodes.length === 1 ? "" : "s"}`,
              )
              .join("; ")}`
          : "No future waves after refinement.";

      const changesSummary = [
        `New nodes: ${addedNodes.length}`,
        `New edges: ${addedEdges.length}`,
        `New repos: ${addedRepos.length}`,
      ].join(" | ");

      const elicitMessage =
        `Refinement ready to apply.\n\n` +
        `Changes: ${changesSummary}\n\n` +
        `${completedWavesSummary}\n` +
        `${revisedWavesSummary}\n\n` +
        `Approve to transition to dispatching state.`;

      const elicitResult = await elicitForm(
        elicitMessage,
        approvalSchema({
          approveTitle: "Approve refinement?",
          modificationsTitle: "Notes (optional)",
        }),
      );

      // Graceful degradation: decline from missing capability — proceed without approval
      const proceedWithoutApproval =
        elicitResult.action === "decline" &&
        !mcp.server.getClientCapabilities()?.elicitation;

      if (!proceedWithoutApproval) {
        if (
          elicitResult.action === "decline" ||
          elicitResult.action === "cancel"
        ) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  reason: "Refinement rejected by user.",
                  machineState: cp.machineState,
                }),
              },
            ],
          };
        }

        if (elicitResult.action === "accept" && !elicitResult.content.approve) {
          const notes =
            typeof elicitResult.content.modifications === "string" &&
            elicitResult.content.modifications.length > 0
              ? elicitResult.content.modifications
              : undefined;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  reason: "Refinement not approved.",
                  machineState: cp.machineState,
                  ...(notes !== undefined ? { notes } : {}),
                }),
              },
            ],
          };
        }
      }

      const refinementRecord = {
        timestamp: new Date().toISOString(),
        addedNodes,
        addedEdges,
        addedRepos,
      };

      const transitioned = transition(
        {
          ...cp,
          waves: mergedWaves,
          refinementHistory: [...cp.refinementHistory, refinementRecord],
        },
        { type: "refinement_approved" },
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
              refinementHistory: checkpoint.refinementHistory,
            }),
          },
        ],
      };
    }

    // initializing state — full computation
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

const dispatchWaveSchema = z.object({
  waveId: z.number().int().describe("Wave index to dispatch"),
});

mcp.registerTool(
  "dispatch_wave",
  {
    title: "Dispatch wave",
    description:
      "Activate all nodes in the specified wave and record it as the current wave.",
    inputSchema: dispatchWaveSchema.shape,
  },
  (params: z.infer<typeof dispatchWaveSchema>) => {
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

const completeNodeSchema = z.object({
  nodeId: z.string().describe("Node ID to complete"),
  prUrl: z.string().optional().describe("URL of the pull request, if any"),
  prNumber: z.number().int().optional().describe("Pull request number, if any"),
});

mcp.registerTool(
  "complete_node",
  {
    title: "Complete Node",
    description:
      "Mark a node as completed. Provide prUrl and prNumber to record a PR; omit to mark as merged directly.",
    inputSchema: completeNodeSchema.shape,
  },
  (params: z.infer<typeof completeNodeSchema>) => {
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

    const pr =
      params.prUrl !== undefined && params.prNumber !== undefined
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

const failNodeSchema = z.object({
  nodeId: z.string().describe("Node ID to fail"),
  reason: z.string().describe("Human-readable failure reason"),
});

mcp.registerTool(
  "fail_node",
  {
    title: "Fail Node",
    description: "Mark a node as failed with a human-readable reason.",
    inputSchema: failNodeSchema.shape,
  },
  async (params: z.infer<typeof failNodeSchema>) => {
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

    const failureData = {
      ok: true,
      nodeId: params.nodeId,
      status: checkpoint.graph.nodes[params.nodeId]?.status,
      machineState: checkpoint.machineState,
    };

    // Elicit triage decision from the user
    const node = checkpoint.graph.nodes[params.nodeId];
    const nodeLabel = node?.label ?? params.nodeId;
    const nodeRepo = node?.repo ?? "unknown";
    const message =
      `Node "${nodeLabel}" (id: ${params.nodeId}, repo: ${nodeRepo}) has failed.\n` +
      `Reason: ${params.reason}\n\n` +
      `Choose how to proceed with this failure.`;

    const elicitResult = await elicitForm(
      message,
      triageSchema({
        decisionTitle: "Triage decision",
        contextTitle: "Additional context (optional)",
      }),
    );

    if (elicitResult.action === "accept") {
      const decision = elicitResult.content.decision as string;
      const context =
        typeof elicitResult.content.context === "string" &&
        elicitResult.content.context.length > 0
          ? elicitResult.content.context
          : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...failureData,
              triage: {
                decision,
                ...(context !== undefined ? { context } : {}),
              },
            }),
          },
        ],
      };
    }

    // decline (no elicitation capability) or cancel — return without triage
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(failureData),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: clear_gate
// ---------------------------------------------------------------------------

const clearGateSchema = z.object({
  nodeId: z.string().describe("Node ID to clear gate for"),
});

mcp.registerTool(
  "clear_gate",
  {
    title: "Clear Gate",
    description:
      "Clear the merge gate on a node. Auto-advances to dispatching state if all gates in the current wave are cleared.",
    inputSchema: clearGateSchema.shape,
  },
  (params: z.infer<typeof clearGateSchema>) => {
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
// Tool: cancel
// ---------------------------------------------------------------------------

const cancelSchema = z.object({
  reason: z.string().optional().describe("Human-readable cancellation reason"),
});

mcp.registerTool(
  "cancel",
  {
    title: "Cancel",
    description:
      "Cancel the current trimatrix execution. Transitions to cancelled state.",
    inputSchema: cancelSchema.shape,
  },
  (params: z.infer<typeof cancelSchema>) => {
    const cp = requireCheckpoint();
    const check = canTransition(cp, { type: "cancel", reason: params.reason });
    if (!check.allowed) throw new Error(`Cannot cancel: ${check.reason}`);
    checkpoint = transition(cp, { type: "cancel", reason: params.reason });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            cancellationReason: checkpoint.cancellationReason,
            cancelledAt: checkpoint.cancelledAt,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: archive
// ---------------------------------------------------------------------------

const archiveSchema = z.object({
  artifactId: z
    .string()
    .describe("Brain artifact ID of the checkpoint to archive"),
  reason: z.string().optional().describe("Archival reason"),
});

mcp.registerTool(
  "archive",
  {
    title: "Archive",
    description:
      "Archive a trimatrix checkpoint artifact. Requires completed or cancelled state.",
    inputSchema: archiveSchema.shape,
  },
  async (params: z.infer<typeof archiveSchema>) => {
    const cp = requireCheckpoint();
    if (
      cp.machineState !== MachineState.COMPLETED &&
      cp.machineState !== MachineState.CANCELLED
    ) {
      throw new Error(
        `archive requires completed or cancelled state, got ${cp.machineState}`,
      );
    }
    const args = ["artifacts", "archive", params.artifactId];
    if (params.reason) {
      args.push("--reason", params.reason);
    }
    try {
      await execFileAsync("brain", args);
    } catch (err) {
      throw new Error(
        `Failed to archive artifact: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            archived: params.artifactId,
            machineState: cp.machineState,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: next_wave
// ---------------------------------------------------------------------------

mcp.registerTool(
  "next_wave",
  {
    title: "Next Wave",
    description:
      "Return the next wave ready for execution, or null with a reason if none is available.",
    inputSchema: {},
  },
  async () => {
    const cp = requireCheckpoint();

    if (cp.machineState === MachineState.GATE_HALTED) {
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

    if (cp.machineState === MachineState.COMPLETED) {
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

    if (cp.machineState === MachineState.CANCELLED) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave: null,
              reason: "Execution cancelled.",
            }),
          },
        ],
      };
    }

    if (cp.machineState === MachineState.FAILED) {
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

    // Build node summary lines for the elicitation message
    const nodeSummaries = wave.nodes
      .map((nodeId) => {
        const node = cp.graph.nodes[nodeId];
        if (!node) return `  - ${nodeId} (unknown)`;
        return `  - ${node.id} | repo: ${node.repo} | ${node.label} | branch: ${node.worktreeBranch}`;
      })
      .join("\n");

    const message =
      `Wave ${wave.id + 1} is ready for dispatch.\n` +
      `Nodes (${wave.nodes.length}):\n${nodeSummaries}\n\n` +
      `Approve this wave to proceed with execution.`;

    const elicitResult = await elicitForm(
      message,
      approvalSchema({
        approveTitle: "Approve this wave?",
        modificationsTitle: "Modification notes (optional)",
      }),
    );

    if (elicitResult.action === "accept") {
      const approved = Boolean(elicitResult.content.approve);
      const modifications =
        typeof elicitResult.content.modifications === "string" &&
        elicitResult.content.modifications.length > 0
          ? elicitResult.content.modifications
          : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave,
              approved,
              ...(modifications !== undefined ? { modifications } : {}),
            }),
          },
        ],
      };
    }

    if (elicitResult.action === "decline") {
      // Client lacks elicitation capability — preserve current behavior
      return {
        content: [{ type: "text", text: JSON.stringify({ wave }) }],
      };
    }

    // cancel
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ wave, approved: false }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: status
// ---------------------------------------------------------------------------

mcp.registerTool(
  "status",
  {
    title: "Status",
    description:
      "Return full state summary including machine state, current wave, node statuses, and wave history. Returns idle state if no checkpoint is loaded.",
    inputSchema: {},
  },
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
            ...(cp.sessionId ? { sessionId: cp.sessionId } : {}),
            ...(cp.sessionLabel ? { sessionLabel: cp.sessionLabel } : {}),
            ...(cp.cancellationReason
              ? { cancellationReason: cp.cancellationReason }
              : {}),
            ...(cp.cancelledAt ? { cancelledAt: cp.cancelledAt } : {}),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_sessions
// ---------------------------------------------------------------------------

mcp.registerTool(
  "list_sessions",
  {
    title: "List sessions",
    description: "List all trimatrix sessions grouped by session ID.",
    inputSchema: {},
  },
  async () => {
    try {
      const { stdout } = await execFileAsync("brain", [
        "artifacts",
        "list",
        "--tag",
        "trimatrix-checkpoint",
        "--json",
      ]);
      const records: Array<{
        recordId: string;
        title: string;
        updatedAt: string;
        tags: string[];
      }> = JSON.parse(stdout);

      // Group by trimatrix-session:* tag
      const sessionMap = new Map<
        string,
        { recordId: string; title: string; updatedAt: string }[]
      >();

      for (const record of records) {
        const sessionTag = record.tags?.find((t) =>
          t.startsWith("trimatrix-session:"),
        );
        const sessionKey = sessionTag
          ? sessionTag.slice("trimatrix-session:".length)
          : "untagged";
        if (!sessionMap.has(sessionKey)) {
          sessionMap.set(sessionKey, []);
        }
        sessionMap.get(sessionKey)!.push({
          recordId: record.recordId,
          title: record.title,
          updatedAt: record.updatedAt,
        });
      }

      const sessions = Array.from(sessionMap.entries()).map(
        ([sessionId, checkpoints]) => {
          const dates = checkpoints.map((c) => c.updatedAt).sort();
          return {
            sessionId,
            checkpoints,
            createdAt: dates[0],
            updatedAt: dates[dates.length - 1],
          };
        },
      );

      // Sort by most recent updatedAt descending
      sessions.sort((a, b) =>
        b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, sessions }),
          },
        ],
      };
    } catch (_err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Failed to query brain records",
            }),
          },
        ],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: save_checkpoint
// ---------------------------------------------------------------------------

mcp.registerTool(
  "save_checkpoint",
  {
    title: "Save checkpoint",
    description:
      "Serialize the current checkpoint to a JSON string for persistence.",
    inputSchema: {},
  },
  () => {
    const cp = requireCheckpoint();
    const json = serialize(cp);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            checkpoint: json,
            ...(cp.sessionId ? { sessionId: cp.sessionId } : {}),
            ...(cp.sessionLabel ? { sessionLabel: cp.sessionLabel } : {}),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: restore_checkpoint
// ---------------------------------------------------------------------------

const restoreCheckpointSchema = z.object({
  checkpoint: z.string().describe("JSON string of a serialized checkpoint"),
});

mcp.registerTool(
  "restore_checkpoint",
  {
    title: "Restore checkpoint",
    description:
      "Deserialize a previously saved checkpoint JSON string and load it into memory.",
    inputSchema: restoreCheckpointSchema.shape,
  },
  (params: z.infer<typeof restoreCheckpointSchema>) => {
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
// Tool: designate
// ---------------------------------------------------------------------------

const designateSchema = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(12)
    .describe("Number of agents to generate designations for (1–12)"),
  role: z
    .enum([
      "Assimilation",
      "Validation",
      "Reconnaissance",
      "TacticalAnalysis",
      "Closure",
    ])
    .optional()
    .describe("Agent role (determines Borg functional title)"),
  trimatrix: z
    .boolean()
    .optional()
    .describe(
      "If true, use 'Trimatrix <random>' as unit instead of 'Unimatrix Zero'",
    ),
  trimatrix_id: z
    .number()
    .int()
    .min(1)
    .max(999)
    .optional()
    .describe("Pin a specific Trimatrix ID instead of generating a random one"),
});

mcp.registerTool(
  "designate",
  {
    title: "Designate",
    description: "Generate Borg-style designations for one or more agents.",
    inputSchema: designateSchema.shape,
  },
  (params: z.infer<typeof designateSchema>) => {
    const result = designate(
      params.count,
      params.role as Role | undefined,
      params.trimatrix,
      params.trimatrix_id,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Brain CLI helpers
// ---------------------------------------------------------------------------

interface BrainRegistryEntry {
  id: string;
  name: string;
  root: string;
  aliases: string[];
  extra_roots: string[];
  prefix: string;
}

async function brainLsJson(): Promise<BrainRegistryEntry[]> {
  const { stdout } = await execFileAsync("brain", ["ls", "--json"]);
  const data = JSON.parse(stdout);
  return data.brains ?? [];
}

function buildLookups(brains: BrainRegistryEntry[]): {
  byId: Map<string, BrainRegistryEntry>;
  byName: Map<string, BrainRegistryEntry>;
  byAlias: Map<string, BrainRegistryEntry>;
  byRoot: Map<string, BrainRegistryEntry>;
} {
  const byId = new Map<string, BrainRegistryEntry>();
  const byName = new Map<string, BrainRegistryEntry>();
  const byAlias = new Map<string, BrainRegistryEntry>();
  const byRoot = new Map<string, BrainRegistryEntry>();
  for (const b of brains) {
    if (b.id) byId.set(b.id, b);
    byName.set(b.name, b);
    for (const alias of b.aliases ?? []) byAlias.set(alias, b);
    byRoot.set(b.root, b);
  }
  return { byId, byName, byAlias, byRoot };
}

// ---------------------------------------------------------------------------
// Tool: resolve_brains
// ---------------------------------------------------------------------------

const resolveBrainsSchema = z.object({
  refs: z
    .array(z.string())
    .min(1)
    .describe(
      "Brain references to resolve — each can be a brain ID, name, alias, or filesystem path",
    ),
});

mcp.registerTool(
  "resolve_brains",
  {
    title: "Resolve brains",
    description:
      "Resolve brain references (ID, name, alias, or filesystem path) to their registry entries. Auto-initializes unregistered paths.",
    inputSchema: resolveBrainsSchema.shape,
  },
  async (params: z.infer<typeof resolveBrainsSchema>) => {
    const brains = await brainLsJson();
    const { byId, byName, byAlias, byRoot } = buildLookups(brains);

    const results: Record<string, unknown>[] = [];
    let hasErrors = false;

    for (const ref of params.refs) {
      // 1. Try as brain ID
      const byIdEntry = byId.get(ref);
      if (byIdEntry) {
        results.push({
          id: byIdEntry.id,
          name: byIdEntry.name,
          root: byIdEntry.root,
          initialized: false,
        });
        continue;
      }

      // 2. Try as brain name
      const byNameEntry = byName.get(ref);
      if (byNameEntry) {
        results.push({
          id: byNameEntry.id,
          name: byNameEntry.name,
          root: byNameEntry.root,
          initialized: false,
        });
        continue;
      }

      // 3. Try as brain alias
      const byAliasEntry = byAlias.get(ref);
      if (byAliasEntry) {
        results.push({
          id: byAliasEntry.id,
          name: byAliasEntry.name,
          root: byAliasEntry.root,
          initialized: false,
        });
        continue;
      }

      // 4. Try as path — resolve ~ and check registry
      const path = ref.startsWith("~")
        ? ref.replace(/^~/, process.env.HOME ?? "")
        : ref;
      const resolved = resolvePath(path);

      const byRootEntry = byRoot.get(resolved);
      if (byRootEntry) {
        results.push({
          id: byRootEntry.id,
          name: byRootEntry.name,
          root: byRootEntry.root,
          initialized: false,
        });
        continue;
      }

      // Not registered — try to auto-init
      try {
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          results.push({
            error: `'${ref}' is not a registered brain and not a valid directory`,
            ref,
          });
          hasErrors = true;
          continue;
        }
      } catch {
        results.push({
          error: `'${ref}' is not a registered brain and path does not exist`,
          ref,
        });
        hasErrors = true;
        continue;
      }

      try {
        await execFileAsync("brain", ["init", "--no-agents-md"], {
          cwd: resolved,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({
          error: `brain init failed at ${resolved}: ${msg}`,
          ref,
        });
        hasErrors = true;
        continue;
      }

      // Re-query registry to get the new entry
      const freshBrains = await brainLsJson();
      const freshLookups = buildLookups(freshBrains);
      const freshEntry = freshLookups.byRoot.get(resolved);
      if (freshEntry) {
        results.push({
          id: freshEntry.id,
          name: freshEntry.name,
          root: freshEntry.root,
          initialized: true,
        });
      } else {
        // Fallback — use directory name
        results.push({
          id: null,
          name: basename(resolved),
          root: resolved,
          initialized: true,
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: !hasErrors,
            results,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: brain_id
// ---------------------------------------------------------------------------

const brainIdSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe(
      "Directory to query. Defaults to the server's working directory.",
    ),
});

mcp.registerTool(
  "brain_id",
  {
    title: "Brain ID",
    description:
      "Return the brain ID and name for the current working directory (or a specified path).",
    inputSchema: brainIdSchema.shape,
  },
  async (params: z.infer<typeof brainIdSchema>) => {
    const cwd = params.cwd ?? process.cwd();

    // Get the ID
    const { stdout: idOut } = await execFileAsync("brain", ["id"], { cwd });
    const id = idOut.trim();

    // Look up the full entry in the registry
    const brains = await brainLsJson();
    const { byId } = buildLookups(brains);
    const entry = byId.get(id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id,
            name: entry?.name ?? null,
            root: entry?.root ?? cwd,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: brain_link
// ---------------------------------------------------------------------------

const brainLinkSchema = z.object({
  name: z.string().describe("Brain name, ID, or alias to link to"),
  cwd: z
    .string()
    .describe("Directory to link (must run from inside the worktree)"),
});

mcp.registerTool(
  "brain_link",
  {
    title: "Link brain",
    description:
      "Link a directory as an additional root for an existing brain. Use after creating a worktree to give spawned agents access to brain tasks and records.",
    inputSchema: brainLinkSchema.shape,
  },
  async (params: z.infer<typeof brainLinkSchema>) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        "brain",
        ["link", params.name],
        { cwd: params.cwd },
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              linked: params.name,
              cwd: params.cwd,
              ...(stdout.trim() ? { output: stdout.trim() } : {}),
              ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
            }),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`brain link failed: ${msg}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await mcp.connect(transport);
