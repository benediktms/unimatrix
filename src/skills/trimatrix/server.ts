/**
 * trimatrix MCP server — exposes graph and state machine operations as MCP tools.
 *
 * Holds ONE checkpoint in memory. Tools require the checkpoint to be initialized
 * before use (via `init` or `restore_checkpoint`).
 */

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
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
import { approvalSchema, EdgeType, Executor, Intent, NodeStatus, NodeType, SubgraphStrategy, Tier, triageSchema } from "./types.ts";
import { designate, type Role } from "./designate.ts";
import {
  activateNodes,
  addEdge,
  addNode,
  clearGate,
  completeNode,
  computeSubgraphs,
  computeWaves,
  computeWavesFromRefinement,
  failNode,
  nextWave,
  parallelNodesInWave,
  serializeSubgraphBrief,
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

const server = new McpServer({
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
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    return { action: "decline" };
  }
  // Our ElicitationRequestedSchema is a structural subset of the SDK's
  // requestedSchema. Cast to the parameter type via Parameters<> to avoid
  // importing the SDK types.js entry directly.
  type ElicitInputParams = Parameters<typeof server.server.elicitInput>[0];
  const raw = await server.server.elicitInput(
    { message, requestedSchema } as ElicitInputParams,
  );
  if (raw.action === "accept") {
    return { action: "accept", content: raw.content ?? {} };
  }
  return { action: raw.action };
}

// ---------------------------------------------------------------------------
// Tool: init
// ---------------------------------------------------------------------------

server.tool(
  "init",
  "Initialize trimatrix with repository metadata. Creates an empty graph and checkpoint in initializing state.",
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
    ).optional().describe("Repository metadata for this execution"),
    sessionLabel: z.string().optional().describe(
      "Human-readable session label. Auto-generated if omitted.",
    ),
    intent: z.nativeEnum(Intent).optional().describe(
      "Classified intent for this execution.",
    ),
    tier: z.nativeEnum(Tier).optional().describe(
      "Complexity tier: T1 (trivial), T2 (moderate), T3 (complex).",
    ),
    subgraphStrategy: z.nativeEnum(SubgraphStrategy).optional().describe(
      "Subgraph partitioning strategy: SELF (lead), INDEPENDENT (adjuncts), COORDINATED (team).",
    ),
  },
  (params) => {
    const repos = (params.repos ?? []) as RepoMetadata[];
    const emptyGraph = { nodes: {}, edges: [] };
    const sessionId = generateSessionId();
    const sessionLabel = params.sessionLabel ?? generateSessionLabel(repos);
    checkpoint = createCheckpoint(repos, emptyGraph, {
      sessionId,
      sessionLabel,
      intent: params.intent,
      tier: params.tier,
      subgraphStrategy: params.subgraphStrategy,
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
            ...(params.intent !== undefined ? { intent: params.intent } : {}),
            ...(params.tier !== undefined ? { tier: params.tier } : {}),
            ...(params.subgraphStrategy !== undefined
              ? { subgraphStrategy: params.subgraphStrategy }
              : {}),
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

    if (cp.machineState !== "initializing" && cp.machineState !== "refining") {
      throw new Error(
        `add_repo requires initializing or refining state, got ${cp.machineState}`,
      );
    }

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
    repo: z.string().optional().describe("Brain name or ref for the target repository (absent for single-repo nodes)"),
    type: z.nativeEnum(NodeType).describe("Node type"),
    label: z.string().describe("Human-readable description"),
    tags: z.array(z.string()).optional().describe("Optional tags for categorisation"),
    worktreeBranch: z.string().optional().describe("Worktree branch name for this node (absent for single-repo nodes)"),
    stackedOn: z.string().optional().describe(
      "Node ID this node is stacked on within the same repository",
    ),
    executor: z.nativeEnum(Executor).optional().describe(
      "Who executes this node: LEAD or ADJUNCT. Defaults to LEAD.",
    ),
  },
  (params) => {
    const cp = requireCheckpoint();

    if (cp.machineState !== "initializing" && cp.machineState !== "refining") {
      throw new Error(
        `add_node requires initializing or refining state, got ${cp.machineState}`,
      );
    }

    const node = {
      id: params.id,
      ...(params.repo !== undefined ? { repo: params.repo } : {}),
      type: params.type,
      label: params.label,
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.worktreeBranch !== undefined ? { worktreeBranch: params.worktreeBranch } : {}),
      ...(params.stackedOn !== undefined
        ? { stackedOn: params.stackedOn }
        : {}),
      status: NodeStatus.PENDING,
      executor: params.executor ?? Executor.LEAD,
    };

    const result = addNode(cp.graph, node, cp.machineState === "refining");
    if (!result.ok) {
      throw new Error(result.error);
    }

    checkpoint = {
      ...cp,
      graph: result.value!,
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
    type: z.nativeEnum(EdgeType).describe("Edge type"),
  },
  (params) => {
    const cp = requireCheckpoint();

    if (cp.machineState !== "initializing" && cp.machineState !== "refining") {
      throw new Error(
        `add_edge requires initializing or refining state, got ${cp.machineState}`,
      );
    }

    const edge = {
      from: params.from,
      to: params.to,
      type: params.type,
    };

    const result = addEdge(cp.graph, edge, cp.machineState === "refining");
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

server.tool(
  "refine",
  "Enter refining state to add new nodes, edges, or repos to an in-progress execution. Call compute_waves when done to apply the changes and resume dispatching.",
  {},
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
  "Validate graph, compute execution waves, and transition to dispatching state. In refining state uses partial recomputation (refinement_approved); in initializing state uses full computation (plan_approved).",
  {},
  async () => {
    const cp = requireCheckpoint();

    const validationResult = validate(cp.graph);
    if (!validationResult.valid) {
      throw new Error(
        `Graph validation failed: ${validationResult.errors.join("; ")}`,
      );
    }

    if (cp.machineState === "refining") {
      // Partial recomputation — preserve completed waves, append new waves
      const check = canTransition(cp, { type: "refinement_approved" });
      if (!check.allowed) {
        throw new Error(`Cannot transition: ${check.reason}`);
      }

      // Determine the last completed wave number to offset new wave IDs
      const completedWaves = cp.waves.filter((w) =>
        w.nodes.every((nId) => {
          const s = cp.graph.nodes[nId]?.status;
          return s === NodeStatus.MERGED || s === NodeStatus.DONE;
        })
      );
      const waveOffset = completedWaves.length > 0
        ? Math.max(...completedWaves.map((w) => w.id))
        : 0;

      const newWaves = computeWavesFromRefinement(cp.graph, waveOffset);

      // Merge: keep completed waves, replace remaining with recomputed waves
      const mergedWaves = [...completedWaves, ...newWaves];

      // Collect what was added in this refinement for the history record
      const existingNodeIds = new Set(
        cp.waves.flatMap((w) => w.nodes),
      );
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
          w.nodes.map((nId) => cp.graph.nodes[nId]?.repo).filter(Boolean)
        ),
      );
      const addedRepos = cp.repos
        .map((r) => r.name)
        .filter((name) => !preRefinementRepoNames.has(name));

      // Build elicitation message summarising the proposed changes
      const completedWavesSummary = completedWaves.length > 0
        ? `Completed waves (read-only): ${completedWaves.map((w) => `Wave ${w.id}`).join(", ")}`
        : "No completed waves.";

      const revisedWavesSummary = newWaves.length > 0
        ? `Revised future waves (${newWaves.length}): ${
          newWaves.map((w) =>
            `Wave ${w.id} — ${w.nodes.length} node${w.nodes.length === 1 ? "" : "s"}`
          ).join("; ")
        }`
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
      const proceedWithoutApproval = elicitResult.action === "decline" &&
        !server.server.getClientCapabilities()?.elicitation;

      if (!proceedWithoutApproval) {
        if (elicitResult.action === "decline" || elicitResult.action === "cancel") {
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
          const notes = typeof elicitResult.content.modifications === "string" &&
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

      // Auto-compute subgraphs if intent and tier are set
      if (checkpoint.intent && checkpoint.tier) {
        const strategy = checkpoint.subgraphStrategy ?? SubgraphStrategy.SELF;
        checkpoint = {
          ...checkpoint,
          subgraphs: computeSubgraphs(checkpoint.graph, checkpoint.waves, checkpoint.tier, strategy),
        };
        for (const sg of checkpoint.subgraphs!) {
          for (const nodeId of sg.nodes) {
            if (checkpoint.graph.nodes[nodeId]) {
              checkpoint.graph.nodes[nodeId] = {
                ...checkpoint.graph.nodes[nodeId],
                subgraph: sg.id,
              };
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              machineState: checkpoint.machineState,
              waves: checkpoint.waves,
              refinementHistory: checkpoint.refinementHistory,
              ...(checkpoint.subgraphs?.length
                ? {
                  subgraphs: checkpoint.subgraphs.map((sg) => ({
                    id: sg.id,
                    executor: sg.executor,
                    nodeCount: sg.nodes.length,
                    coordination: sg.coordination.mode,
                  })),
                }
                : {}),
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

    // Build elicitation summary for the initial wave plan
    const waveSummaryLines = waves.map((w) => {
      const nodeLabels = w.nodes.map((nId) => {
        const n = cp.graph.nodes[nId];
        return n ? `${n.id} (${n.repo ?? "single-repo"}: ${n.label})` : nId;
      }).join(", ");
      return `  Wave ${w.id + 1}: ${w.nodes.length} node${w.nodes.length === 1 ? "" : "s"} — ${nodeLabels}`;
    }).join("\n");

    const elicitMessage =
      `Wave plan computed from graph (${Object.keys(cp.graph.nodes).length} nodes, ${waves.length} waves).\n\n` +
      `${waveSummaryLines}\n\n` +
      `Approve to transition to dispatching state.`;

    const elicitResult = await elicitForm(
      elicitMessage,
      approvalSchema({
        approveTitle: "Approve wave plan?",
        modificationsTitle: "Modification notes (optional)",
      }),
    );

    // Graceful degradation: no elicitation capability — proceed without approval
    const proceedWithoutApproval = elicitResult.action === "decline" &&
      !server.server.getClientCapabilities()?.elicitation;

    if (!proceedWithoutApproval) {
      if (elicitResult.action === "decline" || elicitResult.action === "cancel") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason: "Wave plan rejected by user.",
                machineState: cp.machineState,
              }),
            },
          ],
        };
      }

      if (elicitResult.action === "accept" && !elicitResult.content.approve) {
        const notes = typeof elicitResult.content.modifications === "string" &&
            elicitResult.content.modifications.length > 0
          ? elicitResult.content.modifications
          : undefined;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason: "Wave plan not approved.",
                machineState: cp.machineState,
                ...(notes !== undefined ? { notes } : {}),
              }),
            },
          ],
        };
      }
    }

    const transitioned = transition(
      { ...cp, waves },
      { type: "plan_approved" },
    );
    checkpoint = transitioned;

    // Auto-compute subgraphs if intent and tier are set
    if (checkpoint.intent && checkpoint.tier) {
      const strategy = checkpoint.subgraphStrategy ?? SubgraphStrategy.SELF;
      checkpoint = {
        ...checkpoint,
        subgraphs: computeSubgraphs(checkpoint.graph, checkpoint.waves, checkpoint.tier, strategy),
      };
      for (const sg of checkpoint.subgraphs!) {
        for (const nodeId of sg.nodes) {
          if (checkpoint.graph.nodes[nodeId]) {
            checkpoint.graph.nodes[nodeId] = {
              ...checkpoint.graph.nodes[nodeId],
              subgraph: sg.id,
            };
          }
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            waves: checkpoint.waves,
            ...(checkpoint.subgraphs?.length
              ? {
                subgraphs: checkpoint.subgraphs.map((sg) => ({
                  id: sg.id,
                  executor: sg.executor,
                  nodeCount: sg.nodes.length,
                  coordination: sg.coordination.mode,
                })),
              }
              : {}),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: compute_subgraphs
// ---------------------------------------------------------------------------

server.tool(
  "compute_subgraphs",
  "Recompute subgraph partitions from the current graph. Use after refinement or when changing tier/strategy.",
  {
    tier: z.nativeEnum(Tier).describe("Execution tier"),
    strategy: z.nativeEnum(SubgraphStrategy).describe("Subgraph partitioning strategy"),
  },
  (params) => {
    const cp = requireCheckpoint();

    const subgraphs = computeSubgraphs(cp.graph, cp.waves, params.tier, params.strategy);

    // Stamp subgraph IDs onto nodes
    const updatedNodes = { ...cp.graph.nodes };
    for (const sg of subgraphs) {
      for (const nodeId of sg.nodes) {
        if (updatedNodes[nodeId]) {
          updatedNodes[nodeId] = { ...updatedNodes[nodeId], subgraph: sg.id };
        }
      }
    }

    checkpoint = {
      ...cp,
      graph: { ...cp.graph, nodes: updatedNodes },
      subgraphs,
      updatedAt: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            subgraphs: subgraphs.map((sg) => ({
              id: sg.id,
              executor: sg.executor,
              assignee: sg.assignee,
              nodeCount: sg.nodes.length,
              nodes: sg.nodes,
              coordination: sg.coordination,
            })),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_subgraph
// ---------------------------------------------------------------------------

server.tool(
  "get_subgraph",
  "Retrieve a single subgraph by ID, including its serialized dispatch brief for adjunct injection.",
  {
    subgraphId: z.string().describe("Subgraph ID (e.g., sg-lead, sg-1)"),
  },
  (params) => {
    const cp = requireCheckpoint();
    const sg = cp.subgraphs?.find((s) => s.id === params.subgraphId);
    if (!sg) {
      throw new Error(`Subgraph "${params.subgraphId}" not found.`);
    }
    const brief = serializeSubgraphBrief(cp.graph, sg);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            subgraph: sg,
            brief,
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
  async (params) => {
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

    // Sync task status for activated nodes (best-effort)
    const syncPromises = wave.nodes
      .map((nid) => checkpoint!.graph.nodes[nid])
      .filter((n) => n?.taskId)
      .map((n) => syncTaskStatus(n.taskId!, "activate"));
    await Promise.all(syncPromises);

    // Compute per-node execution info and parallelism groups
    const nodeExecution = wave.nodes.map((nId) => {
      const node = checkpoint!.graph.nodes[nId];
      return {
        id: nId,
        executor: node?.executor ?? Executor.LEAD,
        subgraph: node?.subgraph,
        type: node?.type,
        label: node?.label,
      };
    });
    const batches = parallelNodesInWave(checkpoint.graph, wave);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            waveId: params.waveId,
            activatedNodes: wave.nodes,
            machineState: checkpoint.machineState,
            nodeExecution,
            parallelBatches: batches,
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
  async (params) => {
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

    // Sync task status (best-effort)
    const node = checkpoint.graph.nodes[params.nodeId];
    if (node?.taskId) {
      const nodeStatus = node.status;
      if (nodeStatus === NodeStatus.DONE || nodeStatus === NodeStatus.MERGED) {
        await syncTaskStatus(node.taskId, "close");
      } else if (nodeStatus === NodeStatus.PR_CREATED) {
        // PR created but not yet merged — keep as in_progress
        await syncTaskStatus(node.taskId, "activate");
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
// Tool: fail_node
// ---------------------------------------------------------------------------

server.tool(
  "fail_node",
  "Mark a node as failed with a human-readable reason.",
  {
    nodeId: z.string().describe("Node ID to fail"),
    reason: z.string().describe("Human-readable failure reason"),
  },
  async (params) => {
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

    // Sync task status (best-effort)
    const failedNode = checkpoint.graph.nodes[params.nodeId];
    if (failedNode?.taskId) {
      await syncTaskStatus(failedNode.taskId, "block");
    }

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
    const nodeRepo = node?.repo ?? "single-repo";
    const message =
      `Node "${nodeLabel}" (id: ${params.nodeId}, repo: ${nodeRepo}) has failed.\n` +
      `Reason: ${params.reason}\n\n` +
      `Choose how to proceed with this failure.`;

    const elicitResult = await elicitForm(message, triageSchema({
      decisionTitle: "Triage decision",
      contextTitle: "Additional context (optional)",
    }));

    if (elicitResult.action === "accept") {
      const decision = elicitResult.content.decision as string;
      const context = typeof elicitResult.content.context === "string" &&
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
// Tool: cancel
// ---------------------------------------------------------------------------

server.tool(
  "cancel",
  "Cancel the current trimatrix execution. Transitions to cancelled state. Requires user confirmation.",
  {
    reason: z.string().optional().describe("Human-readable cancellation reason"),
  },
  async (params) => {
    const cp = requireCheckpoint();
    const check = canTransition(cp, { type: "cancel", reason: params.reason });
    if (!check.allowed) throw new Error(`Cannot cancel: ${check.reason}`);

    // Elicit confirmation — cancellation is irreversible
    const nodeCount = Object.keys(cp.graph.nodes).length;
    const activeNodes = Object.values(cp.graph.nodes).filter(
      (n) => n.status === NodeStatus.ACTIVE,
    );
    const elicitMessage =
      `Cancel trimatrix execution?\n\n` +
      `State: ${cp.machineState} | Nodes: ${nodeCount} | Active: ${activeNodes.length}\n` +
      (params.reason ? `Reason: ${params.reason}\n` : "") +
      `\nThis action is irreversible.`;

    const elicitResult = await elicitForm(
      elicitMessage,
      approvalSchema({
        approveTitle: "Confirm cancellation?",
        modificationsTitle: "Cancellation reason (optional)",
      }),
    );

    // Graceful degradation: no elicitation capability — proceed
    const proceedWithoutApproval = elicitResult.action === "decline" &&
      !server.server.getClientCapabilities()?.elicitation;

    if (!proceedWithoutApproval) {
      if (elicitResult.action === "decline" || elicitResult.action === "cancel") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason: "Cancellation rejected by user.",
                machineState: cp.machineState,
              }),
            },
          ],
        };
      }

      if (elicitResult.action === "accept" && !elicitResult.content.approve) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason: "Cancellation not confirmed.",
                machineState: cp.machineState,
              }),
            },
          ],
        };
      }

      // If user provided a reason via the form, use it as override
      if (
        elicitResult.action === "accept" &&
        typeof elicitResult.content.modifications === "string" &&
        elicitResult.content.modifications.length > 0
      ) {
        params.reason = elicitResult.content.modifications;
      }
    }

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

server.tool(
  "archive",
  "Archive a trimatrix checkpoint artifact. Requires completed or cancelled state.",
  {
    artifactId: z.string().describe("Brain artifact ID of the checkpoint to archive"),
    reason: z.string().optional().describe("Archival reason"),
  },
  async (params) => {
    const cp = requireCheckpoint();
    if (cp.machineState !== "completed" && cp.machineState !== "cancelled") {
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

server.tool(
  "next_wave",
  "Return the next wave ready for execution, or null with a reason if none is available.",
  {},
  async () => {
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

    if (cp.machineState === "cancelled") {
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

    // Build node summary lines for the elicitation message
    const nodeSummaries = wave.nodes
      .map((nodeId) => {
        const node = cp.graph.nodes[nodeId];
        if (!node) return `  - ${nodeId} (unknown)`;
        return `  - ${node.id} | repo: ${node.repo ?? "single-repo"} | ${node.label} | branch: ${node.worktreeBranch ?? "n/a"}`;
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
            ...(cp.sessionId ? { sessionId: cp.sessionId } : {}),
            ...(cp.sessionLabel ? { sessionLabel: cp.sessionLabel } : {}),
            ...(cp.intent ? { intent: cp.intent } : {}),
            ...(cp.tier ? { tier: cp.tier } : {}),
            ...(cp.subgraphStrategy
              ? { subgraphStrategy: cp.subgraphStrategy }
              : {}),
            ...(cp.subgraphs?.length
              ? {
                subgraphs: cp.subgraphs.map((sg) => ({
                  id: sg.id,
                  executor: sg.executor,
                  assignee: sg.assignee,
                  nodeCount: sg.nodes.length,
                  coordination: sg.coordination.mode,
                })),
              }
              : {}),
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

server.tool(
  "list_sessions",
  "List all trimatrix sessions grouped by session ID.",
  {},
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
          t.startsWith("trimatrix-session:")
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
        b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0
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
// Checkpoint helpers
// ---------------------------------------------------------------------------

const STATE_DIR = "/tmp";
const BRAIN_CLI = "brain";

/** Run a command with optional stdin data, returning stdout. */
function execWithStdin(
  cmd: string,
  args: string[],
  stdinData?: string,
  timeout = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += String(d); });
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
    if (stdinData) {
      proc.stdin.write(stdinData);
    }
    proc.stdin.end();
  });
}

interface BrainTask {
  task_id: string;
  title: string;
  status: string;
  assignee?: string;
  priority?: string;
  parent_task_id?: string;
  task_type?: string;
}

async function queryBrainTasks(status: string): Promise<BrainTask[]> {
  try {
    const { stdout } = await execFileAsync(BRAIN_CLI, [
      "tasks", "list", "--json", `--status=${status}`,
    ], { timeout: 5000 });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    return [];
  } catch {
    return [];
  }
}

async function queryBrainBlockedTasks(): Promise<BrainTask[]> {
  try {
    const { stdout } = await execFileAsync(BRAIN_CLI, [
      "tasks", "list", "--json", "--blocked",
    ], { timeout: 5000 });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    return [];
  } catch {
    return [];
  }
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function formatTaskTable(
  tasks: BrainTask[],
  columns: string[],
): string {
  if (tasks.length === 0) return "";
  const COLUMN_KEY_MAP: Record<string, string> = { id: "task_id" };
  const header = "| " + columns.join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const rows = tasks.slice(0, 15).map((t) => {
    const cells = columns.map((col) => {
      const key = COLUMN_KEY_MAP[col.toLowerCase()] ?? col.toLowerCase().replace(/ /g, "_");
      return String((t as unknown as Record<string, unknown>)[key] ?? "-");
    });
    return "| " + cells.join(" | ") + " |";
  });
  return [header, sep, ...rows].join("\n");
}

function formatAgents(agentsState: Record<string, unknown>): string {
  const active = (agentsState.active ?? {}) as Record<string, Record<string, unknown>>;
  if (Object.keys(active).length === 0) return "";
  const now = Date.now() / 1000;
  return Object.entries(active).map(([aid, info]) => {
    const agentType = String(info.type ?? "unknown");
    const started = Number(info.started_at ?? now);
    const elapsed = Math.floor(now - started);
    const duration = elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
      : `${elapsed}s`;
    const shortId = aid.length > 12 ? aid.slice(0, 12) : aid;
    return `- \`${shortId}\`: **${agentType}** (running for ${duration})`;
  }).join("\n");
}

function buildCheckpointMarkdown(
  opts: {
    compactionNum: number;
    tasksInProgress: BrainTask[];
    tasksOpen: BrainTask[];
    tasksBlocked: BrainTask[];
    agentsState: Record<string, unknown> | null;
    costsState: Record<string, unknown> | null;
    graphJson: string | null;
  },
): string {
  const sections: string[] = [];
  sections.push(`# Post-Compaction Checkpoint (compaction #${opts.compactionNum})`);

  if (opts.tasksInProgress.length > 0) {
    sections.push("\n## In-Progress Tasks");
    sections.push(formatTaskTable(opts.tasksInProgress, ["ID", "Title", "Status", "Assignee", "Priority"]));
  }
  if (opts.tasksOpen.length > 0) {
    sections.push("\n## Open Tasks");
    sections.push(formatTaskTable(opts.tasksOpen, ["ID", "Title", "Status", "Assignee", "Priority"]));
  }
  if (opts.tasksBlocked.length > 0) {
    sections.push("\n## Blocked Tasks");
    sections.push(formatTaskTable(opts.tasksBlocked, ["ID", "Title", "Status", "Priority"]));
  }

  const agentsMd = opts.agentsState ? formatAgents(opts.agentsState) : "";
  if (agentsMd) {
    sections.push("\n## Active Subagents");
    sections.push(agentsMd);
  }

  if (opts.graphJson) {
    sections.push("\n## Graph State");
    sections.push("```json\n" + opts.graphJson + "\n```");
  }

  // Session stats
  const totalCost = opts.costsState
    ? Number(opts.costsState.total_subagent_cost_usd ?? 0)
    : 0;
  const totalTime = opts.agentsState
    ? Number(opts.agentsState.total_subagent_seconds ?? 0)
    : 0;

  const statsParts = [`Compactions: ${opts.compactionNum}`];
  if (totalCost > 0) statsParts.push(`Subagent cost: $${totalCost.toFixed(2)}`);
  if (totalTime > 0) statsParts.push(`Subagent time: ${Math.floor(totalTime)}s`);

  const nActive = opts.agentsState
    ? Object.keys((opts.agentsState.active ?? {}) as Record<string, unknown>).length
    : 0;
  const taskSummary: string[] = [];
  if (opts.tasksInProgress.length > 0) taskSummary.push(`${opts.tasksInProgress.length} in-progress`);
  if (opts.tasksOpen.length > 0) taskSummary.push(`${opts.tasksOpen.length} open`);
  if (opts.tasksBlocked.length > 0) taskSummary.push(`${opts.tasksBlocked.length} blocked`);
  if (nActive > 0) taskSummary.push(`${nActive} subagents active`);
  if (taskSummary.length > 0) statsParts.push("Tasks: " + taskSummary.join(", "));

  sections.push("\n## Session Stats");
  sections.push(statsParts.join(" | "));

  // Recommend action if there are tasks but no active subagents
  const hasWork = opts.tasksInProgress.length > 0 || opts.tasksOpen.length > 0;
  const hasAgents = nActive > 0;
  if (hasWork && !hasAgents) {
    sections.push("\n## Recommended Action");
    sections.push(
      "Subagents were lost during compaction. Resume with the task ID — " +
      "dispatch Assimilation adjuncts for the remaining tasks.",
    );
  }

  return sections.join("\n");
}

async function saveBrainSnapshot(
  title: string,
  tags: string[],
  content: string,
): Promise<void> {
  try {
    const tagArgs = tags.flatMap((t) => ["--tag", t]);
    await execWithStdin(BRAIN_CLI, [
      "snapshots", "save", "--stdin",
      "--title", title,
      ...tagArgs,
      "--media-type", "text/markdown",
    ], content);
  } catch {
    // Best-effort — do not fail the tool call
  }
}

// ---------------------------------------------------------------------------
// Task status sync helpers
// ---------------------------------------------------------------------------

async function syncTaskStatus(
  taskId: string,
  action: "activate" | "block" | "close",
): Promise<void> {
  try {
    if (action === "close") {
      await execFileAsync(BRAIN_CLI, ["tasks", "close", taskId], { timeout: 5000 });
    } else {
      const newStatus = action === "activate" ? "in_progress" : "blocked";
      const eventJson = JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks_apply_event",
        params: { task_id: taskId, event: { type: "status_changed", status: newStatus } },
        id: 1,
      });
      await execWithStdin(BRAIN_CLI, ["mcp"], eventJson);
    }
  } catch {
    // Best-effort — graph remains source of truth
  }
}

// ---------------------------------------------------------------------------
// Tool: save_checkpoint
// ---------------------------------------------------------------------------

server.tool(
  "save_checkpoint",
  "Serialize the current checkpoint to a JSON string for persistence. When claude_session_id is provided, also captures brain tasks, agent/cost state, and saves a brain snapshot.",
  {
    claude_session_id: z.string().optional().describe(
      "Claude Code session ID — enables capture of /tmp state files and saves brain snapshot for post-compaction recovery",
    ),
  },
  async (params) => {
    // Graph checkpoint (may be null if no graph initialized)
    let graphJson: string | null = null;
    if (checkpoint) {
      graphJson = serialize(checkpoint);
    } else if (!params.claude_session_id) {
      // Original behavior: require checkpoint when no session ID
      throw new Error(
        "No checkpoint loaded. Call init or restore_checkpoint first.",
      );
    }

    const result: Record<string, unknown> = {};
    if (graphJson) {
      result.checkpoint = graphJson;
      if (checkpoint?.sessionId) result.sessionId = checkpoint.sessionId;
      if (checkpoint?.sessionLabel) result.sessionLabel = checkpoint.sessionLabel;
    }

    // Enhanced checkpoint with session state
    if (params.claude_session_id) {
      const sid = params.claude_session_id;

      // Query brain tasks
      const [tasksInProgress, tasksOpen, tasksBlocked] = await Promise.all([
        queryBrainTasks("in_progress"),
        queryBrainTasks("open"),
        queryBrainBlockedTasks(),
      ]);

      // Read /tmp state files
      const agentsState = await readJsonFile(
        join(STATE_DIR, `unimatrix-agents-${sid}.json`),
      );
      const costsState = await readJsonFile(
        join(STATE_DIR, `unimatrix-costs-${sid}.json`),
      );
      const compactionsState = await readJsonFile(
        join(STATE_DIR, `unimatrix-compactions-${sid}.json`),
      );

      const compactionNum = compactionsState
        ? Number(compactionsState.compaction_count ?? 1)
        : 1;

      // Build unified markdown checkpoint
      const markdown = buildCheckpointMarkdown({
        compactionNum,
        tasksInProgress,
        tasksOpen,
        tasksBlocked,
        agentsState,
        costsState,
        graphJson,
      });

      // Save brain snapshot
      const snapshotTags = ["trimatrix-checkpoint", "compaction-checkpoint"];
      const parts = [`Compaction #${compactionNum}`];
      const counts: string[] = [];
      if (tasksInProgress.length > 0) counts.push(`${tasksInProgress.length} in-progress`);
      if (tasksOpen.length > 0) counts.push(`${tasksOpen.length} open`);
      if (tasksBlocked.length > 0) counts.push(`${tasksBlocked.length} blocked`);
      if (counts.length > 0) parts.push(counts.join(", "));
      if (graphJson) parts.push("graph attached");

      await saveBrainSnapshot(parts.join(" — "), snapshotTags, markdown);

      result.capturedState = {
        tasksInProgress: tasksInProgress.length,
        tasksOpen: tasksOpen.length,
        tasksBlocked: tasksBlocked.length,
        hasAgents: agentsState !== null,
        hasCosts: costsState !== null,
        hasGraph: graphJson !== null,
        compactionNum,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
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
// Tool: designate
// ---------------------------------------------------------------------------

server.tool(
  "designate",
  "Generate Borg-style designations for one or more agents.",
  {
    count: z.number().int().min(1).max(12).describe(
      "Number of agents to generate designations for (1–12)",
    ),
    role: z.enum(["Assimilation", "Validation", "Reconnaissance", "TacticalAnalysis", "Closure"])
      .optional()
      .describe("Agent role (determines Borg functional title)"),
    trimatrix: z.boolean().optional().describe(
      "If true, use 'Trimatrix <random>' as unit instead of 'Unimatrix Zero'",
    ),
    trimatrix_id: z.number().int().min(1).max(999).optional().describe(
      "Pin a specific Trimatrix ID instead of generating a random one",
    ),
  },
  (params) => {
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

server.tool(
  "resolve_brains",
  "Resolve brain references (ID, name, alias, or filesystem path) to their registry entries. Auto-initializes unregistered paths.",
  {
    refs: z.array(z.string()).min(1).describe(
      "Brain references to resolve — each can be a brain ID, name, alias, or filesystem path",
    ),
  },
  async (params) => {
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

server.tool(
  "brain_id",
  "Return the brain ID and name for the current working directory (or a specified path).",
  {
    cwd: z.string().optional().describe(
      "Directory to query. Defaults to the server's working directory.",
    ),
  },
  async (params) => {
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

server.tool(
  "brain_link",
  "Link a directory as an additional root for an existing brain. Use after creating a worktree to give spawned agents access to brain tasks and records.",
  {
    name: z.string().describe("Brain name, ID, or alias to link to"),
    cwd: z.string().describe(
      "Directory to link (must run from inside the worktree)",
    ),
  },
  async (params) => {
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
await server.connect(transport);
