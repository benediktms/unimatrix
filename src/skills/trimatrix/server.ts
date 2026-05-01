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
  WorkPacket,
} from "./types.ts";
import {
  approvalSchema,
  CoordinationMode,
  EdgeType,
  Executor,
  Intent,
  MachineState,
  NodeStatus,
  NodeType,
  SubgraphCompletionPolicy,
  SubgraphFailurePolicy,
  SubgraphStrategy,
  Tier,
  triageSchema,
} from "./types.ts";
import type { Edge, Graph, Node, Subgraph, SubgraphSummary } from "./types.ts";
import { deriveTrimatrixId, designate, Role } from "./designate.ts";
import {
  activateNodes,
  addEdge,
  addNode,
  addSubgraph,
  canDispatch,
  clearGate,
  closeNodeGuard,
  completeNode,
  computeSubgraphs,
  computeWaves,
  computeWavesFromRefinement,
  currentFrontier,
  failNode,
  nextFrontierBatch,
  nextWave,
  parallelNodesInWave,
  serializeSubgraphBrief,
  SUBGRAPH_SLUG_RE,
  subgraphOutcomeWithBlockers,
  unsatisfiedDependencies,
  updateNode,
  validate,
  validateDispatch,
  waveStatus,
} from "./graph.ts";
import {
  canTransition,
  createCheckpoint,
  deserialize,
  pendingGates,
  serialize,
  transition,
  validateCheckpointAgainstLog,
} from "./state.ts";
import {
  buildExternalBlockerResponse,
  callBrainTool,
  getExternalBlockers,
  repoRoot as repoRootLookup,
  searchEpisodes as searchEpisodesCore,
  syncGraphDepsToBrain as syncGraphDepsToBrainCore,
} from "./brain-sync.ts";
import type { BrainExec, ExternalBlockerSnapshot } from "./brain-sync.ts";
import { EventLogWriter } from "./event-log-writer.ts";
import { createEffectRunner } from "./side-effect-runner.ts";
import { materializePlan } from "./materialize.ts";
import { buildSagaReport, renderSagaReport } from "./saga_report.ts";
import type { NodeSummaryEntry } from "./saga_report.ts";

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

/**
 * Recompute subgraph partitions and stamp each node with its subgraph ID.
 * Returns a new immutable checkpoint. No-op if tier/strategy are absent.
 *
 * Explicit subgraphs (`derived: false`) are preserved as-is; derived subgraphs
 * are recomputed against the set of nodes not already claimed by an explicit
 * subgraph. This lets a caller declare structure once via `add_subgraph` and
 * have subsequent `compute_subgraphs` runs honor it instead of overwriting.
 */
function applySubgraphs(
  cp: Checkpoint,
  overrides?: { tier: Tier; strategy: SubgraphStrategy },
): Checkpoint {
  const tier = overrides?.tier ?? cp.tier;
  const strategy = overrides?.strategy ?? cp.subgraphStrategy ??
    SubgraphStrategy.SELF;
  if (!tier) return cp;

  const explicit = (cp.subgraphs ?? []).filter((sg) => !sg.derived);

  let derivationGraph: Graph = cp.graph;
  if (explicit.length > 0) {
    const claimed = new Set<string>();
    for (const sg of explicit) {
      for (const id of sg.nodes) claimed.add(id);
    }
    if (claimed.size > 0) {
      const remainingNodes: Record<string, Node> = {};
      for (const [id, node] of Object.entries(cp.graph.nodes)) {
        if (!claimed.has(id)) remainingNodes[id] = node;
      }
      const remainingEdges: Edge[] = cp.graph.edges.filter(
        (e) => !claimed.has(e.from) && !claimed.has(e.to),
      );
      derivationGraph = { nodes: remainingNodes, edges: remainingEdges };
    }
  }

  const derived = computeSubgraphs(derivationGraph, cp.waves, tier, strategy);

  // M1: Post-process derived subgraph dependsOn for cross-edge resolution.
  // When explicit subgraphs exist, edges crossing from an explicit-subgraph
  // member into a derived-subgraph member are inter-subgraph dependencies.
  // These are invisible to computeSubgraphs (which only sees the unclaimed
  // subgraph). We resolve them here so derived subgraphs know their upstream.
  let patchedDerived = derived;
  if (explicit.length > 0) {
    // Build a map: nodeId → explicit subgraph ID
    const nodeToExplicit = new Map<string, string>();
    for (const sg of explicit) {
      for (const nodeId of sg.nodes) {
        nodeToExplicit.set(nodeId, sg.id);
      }
    }

    // Build a map: nodeId → derived subgraph ID
    const nodeToDerived = new Map<string, string>();
    for (const sg of derived) {
      for (const nodeId of sg.nodes) {
        nodeToDerived.set(nodeId, sg.id);
      }
    }

    // Walk all graph edges: for each edge where from is in an explicit subgraph
    // and to is in a derived subgraph, record the dependency.
    const derivedDepsMap = new Map<string, Set<string>>();
    for (const edge of cp.graph.edges) {
      const fromExplicit = nodeToExplicit.get(edge.from);
      const toDerived = nodeToDerived.get(edge.to);
      if (fromExplicit && toDerived) {
        if (!derivedDepsMap.has(toDerived)) {
          derivedDepsMap.set(toDerived, new Set());
        }
        derivedDepsMap.get(toDerived)!.add(fromExplicit);
      }
    }

    // Patch derived subgraphs: merge discovered explicit deps into their
    // coordination.dependsOn, skipping NONE-mode (lead subgraph in SELF strategy).
    if (derivedDepsMap.size > 0) {
      patchedDerived = derived.map((sg) => {
        if (sg.coordination.mode === CoordinationMode.NONE) return sg;
        const newDeps = derivedDepsMap.get(sg.id);
        if (!newDeps || newDeps.size === 0) return sg;
        const merged = Array.from(
          new Set([...(sg.coordination.dependsOn ?? []), ...newDeps]),
        ).sort();
        return {
          ...sg,
          coordination: { ...sg.coordination, dependsOn: merged },
        };
      });
    }
  }

  const subgraphs: Subgraph[] = [...explicit, ...patchedDerived];

  const updatedNodes = { ...cp.graph.nodes };
  for (const sg of subgraphs) {
    for (const nodeId of sg.nodes) {
      if (updatedNodes[nodeId]) {
        updatedNodes[nodeId] = { ...updatedNodes[nodeId], subgraph: sg.id };
      }
    }
  }
  return {
    ...cp,
    graph: { ...cp.graph, nodes: updatedNodes },
    subgraphs,
  };
}

function generateSessionLabel(repos: RepoMetadata[]): string {
  return repos.map((r) => r.name).join(", ");
}

/**
 * Project a Subgraph into the JSON shape returned by tool responses.
 *
 * Includes the new explicit-subgraph fields (label, parentId, derived,
 * completionPolicy, failurePolicy, gates) and a computed `outcome` derived
 * from the policies plus current node statuses, so callers can tell at a
 * glance whether a subgraph is pending, active, completed, or failed.
 */
/**
 * Build a `Map<taskId, unresolvedCount>` from the cached `externalBlockers`
 * fields stamped on graph nodes by the most recent `dispatch_wave` brain
 * consultation. The map is consumed by `subgraphOutcomeWithBlockers` so the
 * status response reflects whether external gates have cleared without a
 * fresh brain round-trip on every status read.
 *
 * Each `Node.externalBlockers[]` entry is treated as unresolved unless its
 * `resolvedAt` field is set (matches the brain `external_blocker_resolved`
 * event semantics).
 */
function externalBlockerSnapshot(graph: Graph): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const node of Object.values(graph.nodes)) {
    if (!node.taskId || !node.externalBlockers) continue;
    const unresolved = node.externalBlockers.filter((b) =>
      b.resolvedAt === undefined
    ).length;
    if (unresolved > 0) snapshot.set(node.taskId, unresolved);
  }
  return snapshot;
}

function summarizeSubgraph(sg: Subgraph, graph: Graph): SubgraphSummary {
  return {
    id: sg.id,
    executor: sg.executor,
    tier: sg.tier,
    assignee: sg.assignee,
    nodeCount: sg.nodes.length,
    nodes: sg.nodes,
    coordination: sg.coordination,
    derived: sg.derived,
    completionPolicy: sg.completionPolicy,
    failurePolicy: sg.failurePolicy,
    // Use the blocker-aware variant so GATED outcomes correctly reflect
    // external-blocker state cached on the graph from prior dispatch_wave
    // consultations. Falls through to the blocker-blind path when no
    // external blockers are present (snapshot is empty).
    outcome: subgraphOutcomeWithBlockers(
      graph,
      sg,
      externalBlockerSnapshot(graph),
    ),
    ...(sg.label !== undefined ? { label: sg.label } : {}),
    ...(sg.parentId !== undefined ? { parentId: sg.parentId } : {}),
    ...(sg.gates ? { gates: sg.gates } : {}),
  };
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
    signals: z.record(z.number()).optional().describe(
      "Routing signals (signal name → numeric value) computed by the classifier.",
    ),
    score: z.number().min(0).max(1).optional().describe(
      "Composite routing score in [0, 1] from weighted signals.",
    ),
    routingTrace: z.string().optional().describe(
      "One-sentence rationale plus override-gate fired (if any) for the routing decision.",
    ),
  },
  async (params) => {
    const repos = (params.repos ?? []) as RepoMetadata[];
    const emptyGraph = { nodes: {}, edges: [] };
    const sessionId = generateSessionId();
    const sessionLabel = params.sessionLabel ?? generateSessionLabel(repos);

    // Build routing trace if any routing fields supplied.
    const hasRouting = params.signals !== undefined ||
      params.score !== undefined ||
      params.routingTrace !== undefined;
    const routingTrace = hasRouting
      ? {
        signals: params.signals ?? {},
        score: params.score ?? 0,
        trace: params.routingTrace ?? "",
      }
      : undefined;

    checkpoint = createCheckpoint(repos, emptyGraph, {
      sessionId,
      sessionLabel,
      intent: params.intent,
      tier: params.tier,
      subgraphStrategy: params.subgraphStrategy,
      routingTrace,
    });

    // Activate the file-based event log writer for this session.
    effectDeps.logWriter = new EventLogWriter(sessionId);

    // Search for prior episodes to inform planning (best-effort)
    const priorEpisodes = await searchPriorEpisodes(
      sessionLabel,
      ["trimatrix"],
    ).then((eps) => eps.slice(0, 5));

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
            ...(routingTrace !== undefined ? { routingTrace } : {}),
            ...(priorEpisodes.length > 0 ? { priorEpisodes } : {}),
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
    ).optional().describe(
      "Worktree metadata (can be added later via add_node)",
    ),
  },
  (params) => {
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
    repo: z.string().optional().describe(
      "Brain name or ref for the target repository (absent for single-repo nodes)",
    ),
    type: z.nativeEnum(NodeType).describe("Node type"),
    label: z.string().describe("Human-readable description"),
    tags: z.array(z.string()).optional().describe(
      "Optional tags for categorisation",
    ),
    worktreeBranch: z.string().optional().describe(
      "Worktree branch name for this node (absent for single-repo nodes)",
    ),
    stackedOn: z.string().optional().describe(
      "Node ID this node is stacked on within the same repository",
    ),
    executor: z.nativeEnum(Executor).optional().describe(
      "Who executes this node: LEAD or ADJUNCT. Defaults to LEAD.",
    ),
    taskId: z.string().optional().describe(
      "Brain task ID to associate with this node. Validated against brain CLI.",
    ),
    elicitPrompt: z.string().optional().describe(
      "Markdown prompt to present during elicitation. Required for ELICIT_GATE nodes.",
    ),
    elicitSchema: z.object({
      type: z.literal("object"),
      properties: z.record(z.union([
        // String (plain — no enum)
        z.object({
          type: z.literal("string"),
          title: z.string().optional(),
          description: z.string().optional(),
          minLength: z.number().optional(),
          maxLength: z.number().optional(),
          format: z.string().optional(),
        }).strict(),
        // String enum
        z.object({
          type: z.literal("string"),
          enum: z.array(z.string()),
          enumNames: z.array(z.string()).optional(),
          title: z.string().optional(),
          description: z.string().optional(),
        }).strict(),
        // Number / integer
        z.object({
          type: z.enum(["number", "integer"]),
          title: z.string().optional(),
          description: z.string().optional(),
          minimum: z.number().optional(),
          maximum: z.number().optional(),
        }).strict(),
        // Boolean
        z.object({
          type: z.literal("boolean"),
          title: z.string().optional(),
          description: z.string().optional(),
          default: z.boolean().optional(),
        }).strict(),
      ])),
      required: z.array(z.string()).optional(),
    }).optional().describe(
      "JSON Schema for the elicitation form. Only for ELICIT_GATE nodes. Defaults to approval schema if omitted.",
    ),
    requirements: z.object({
      repos: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      canWrite: z.boolean().optional(),
      humanPresent: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
    }).optional().describe(
      "Capability requirements for this node. When dispatch_wave is called with capabilities, every required token must be satisfied by the dispatcher or the node is held back from activation.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();

    if (
      cp.machineState !== MachineState.INITIALIZING &&
      cp.machineState !== MachineState.REFINING
    ) {
      throw new Error(
        `add_node requires initializing or refining state, got ${cp.machineState}`,
      );
    }

    // Validate taskId exists in brain if provided. Uses `tasks show
    // --output=json` — the canonical CLI subcommand and current output flag.
    // (`tasks get` is the MCP method name and does not exist on the CLI
    // surface; `--json` is deprecated in favor of `--output=json`. See
    // unm-17c.)
    if (params.taskId) {
      try {
        await execFileAsync(BRAIN_CLI, [
          "tasks",
          "show",
          params.taskId,
          "--output=json",
        ], { timeout: 5000 });
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr?.trim();
        const detail = stderr ? ` (${stderr})` : "";
        throw new Error(
          `Task ID "${params.taskId}" does not exist in brain — cannot associate with node "${params.id}"${detail}`,
        );
      }
    }

    // Validate repo exists in checkpoint
    if (params.repo !== undefined) {
      const repoExists = cp.repos.some((r) => r.name === params.repo);
      if (!repoExists) {
        throw new Error(
          `Node "${params.id}" references unknown repo "${params.repo}". ` +
            `Available repos: ${
              cp.repos.map((r) => r.name).join(", ") || "(none)"
            }. ` +
            `Add repo via add_repo first.`,
        );
      }
    }

    if (params.type === NodeType.ELICIT_GATE) {
      if (!params.elicitPrompt) {
        throw new Error(
          `ELICIT_GATE node "${params.id}" requires elicitPrompt`,
        );
      }
    } else {
      if (
        params.elicitPrompt !== undefined || params.elicitSchema !== undefined
      ) {
        throw new Error(
          `elicitPrompt/elicitSchema are only valid for ELICIT_GATE nodes, got type ${params.type}`,
        );
      }
    }

    const node = {
      id: params.id,
      ...(params.repo !== undefined ? { repo: params.repo } : {}),
      type: params.type,
      label: params.label,
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
      ...(params.worktreeBranch !== undefined
        ? { worktreeBranch: params.worktreeBranch }
        : {}),
      ...(params.stackedOn !== undefined
        ? { stackedOn: params.stackedOn }
        : {}),
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      ...(params.elicitPrompt !== undefined
        ? { elicitPrompt: params.elicitPrompt }
        : {}),
      ...(params.elicitSchema !== undefined
        ? { elicitSchema: params.elicitSchema }
        : {}),
      ...(params.requirements !== undefined
        ? { requirements: params.requirements }
        : {}),
      status: NodeStatus.PENDING,
      executor: params.executor ?? Executor.LEAD,
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
      type: params.type,
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

server.tool(
  "refine",
  "Enter refining state to add new nodes, edges, or repos to an in-progress execution. Call compute_waves when done to apply the changes and resume dispatching.",
  {},
  async () => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, { type: "refine" });
    if (!check.allowed) {
      throw new Error(`Cannot enter refining state: ${check.reason}`);
    }

    // Lease-fence invalidation moved into the `refine` transition (state.ts)
    // so event-log replay reproduces the bump. The server tool just emits
    // the event; transition increments leaseVersion on every node.
    const result = await transitionWithEffects(cp, { type: "refine" });
    checkpoint = result.checkpoint;

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
  "Validate graph and compute execution waves. In initializing state, transitions to plan_review (call finalize_plan to approve). In refining state, uses partial recomputation and transitions to dispatching (refinement_approved). Pass `approve: true` to bypass interactive elicitation in refining state — required for headless/subagent contexts where elicitForm cannot be presented.",
  {
    approve: z.boolean().optional().describe(
      "If true and machineState is refining, bypass the interactive elicitForm approval prompt and transition directly to refinement_approved. Use for headless callers (CI, subagents) or to recover from a wedged refining state where prior elicitations cannot be resolved (see unm-735.15).",
    ),
    notes: z.string().optional().describe(
      "Optional notes recorded with the refinement. Only used when `approve: true`.",
    ),
  },
  async (params: { approve?: boolean; notes?: string }) => {
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
        ? `Completed waves (read-only): ${
          completedWaves.map((w) => `Wave ${w.id}`).join(", ")
        }`
        : "No completed waves.";

      const revisedWavesSummary = newWaves.length > 0
        ? `Revised future waves (${newWaves.length}): ${
          newWaves.map((w) =>
            `Wave ${w.id} — ${w.nodes.length} node${
              w.nodes.length === 1 ? "" : "s"
            }`
          ).join("; ")
        }`
        : "No future waves after refinement.";

      const changesSummary = [
        `New nodes: ${addedNodes.length}`,
        `New edges: ${addedEdges.length}`,
        `New repos: ${addedRepos.length}`,
      ].join(" | ");

      // Headless / wedge-recovery short-circuit: if caller explicitly approves
      // via the `approve: true` parameter, skip the interactive elicitForm and
      // transition directly. Required for subagents, CI, and recovery from a
      // wedged refining state where elicitForm cannot be presented or has
      // already been declined (see unm-735.15).
      if (params.approve === true) {
        const refinementRecord = {
          timestamp: new Date().toISOString(),
          addedNodes,
          addedEdges,
          addedRepos,
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
        };

        const refinementResult = await transitionWithEffects(
          {
            ...cp,
            waves: mergedWaves,
            refinementHistory: [...cp.refinementHistory, refinementRecord],
          },
          { type: "refinement_approved" },
        );
        checkpoint = applySubgraphs(refinementResult.checkpoint);

        await syncGraphDepsToBrainCore(cp.graph, undefined, brainExec);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                machineState: checkpoint.machineState,
                waves: checkpoint.waves,
                refinementHistory: checkpoint.refinementHistory,
                approvedHeadless: true,
              }),
            },
          ],
        };
      }

      const elicitMessage = `Refinement ready to apply.\n\n` +
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

      if (
        elicitResult.action === "decline" || elicitResult.action === "cancel"
      ) {
        const noCapability = elicitResult.action === "decline" &&
          !server.server.getClientCapabilities()?.elicitation;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason: noCapability
                  ? "Client lacks elicitation capability. Refinement requires manual approval."
                  : "Refinement rejected by user.",
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

      const refinementRecord = {
        timestamp: new Date().toISOString(),
        addedNodes,
        addedEdges,
        addedRepos,
      };

      const refinementResult = await transitionWithEffects(
        {
          ...cp,
          waves: mergedWaves,
          refinementHistory: [...cp.refinementHistory, refinementRecord],
        },
        { type: "refinement_approved" },
      );
      checkpoint = applySubgraphs(refinementResult.checkpoint);

      // Project graph deps to brain tasks (best-effort)
      await syncGraphDepsToBrainCore(cp.graph, undefined, brainExec);

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
                  subgraphs: checkpoint.subgraphs.map((sg) =>
                    summarizeSubgraph(sg, checkpoint!.graph)
                  ),
                }
                : {}),
            }),
          },
        ],
      };
    }

    // initializing state — full computation, transition to plan_review
    const check = canTransition(cp, { type: "plan_submitted" });
    if (!check.allowed) {
      throw new Error(`Cannot transition: ${check.reason}`);
    }

    const waves = computeWaves(cp.graph);

    const planResult = await transitionWithEffects(
      { ...cp, waves },
      { type: "plan_submitted" },
    );
    checkpoint = planResult.checkpoint;

    // Project graph deps to brain tasks (best-effort)
    await syncGraphDepsToBrainCore(cp.graph, undefined, brainExec);

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
// Tool: finalize_plan
// ---------------------------------------------------------------------------

server.tool(
  "finalize_plan",
  "Approve the wave plan and transition from plan_review to dispatching. Auto-computes subgraphs if intent and tier are set.",
  {},
  async () => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, { type: "plan_finalized" });
    if (!check.allowed) {
      throw new Error(`Cannot finalize plan: ${check.reason}`);
    }

    const finalizeResult = await transitionWithEffects(cp, {
      type: "plan_finalized",
    });
    checkpoint = applySubgraphs(finalizeResult.checkpoint);

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
                subgraphs: checkpoint.subgraphs.map((sg) =>
                  summarizeSubgraph(sg, checkpoint!.graph)
                ),
              }
              : {}),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: revise_plan
// ---------------------------------------------------------------------------

server.tool(
  "revise_plan",
  "Request plan revision — transition from plan_review back to initializing for edits.",
  {},
  async () => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, { type: "plan_revision_requested" });
    if (!check.allowed) {
      throw new Error(`Cannot revise plan: ${check.reason}`);
    }

    const reviseResult = await transitionWithEffects(cp, {
      type: "plan_revision_requested",
    });
    checkpoint = reviseResult.checkpoint;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            message:
              "Plan revision requested. State returned to initializing — modify nodes/edges then call compute_waves again.",
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
    strategy: z.nativeEnum(SubgraphStrategy).describe(
      "Subgraph partitioning strategy",
    ),
  },
  (params) => {
    const cp = requireCheckpoint();

    // M5: Capture old derived subgraph IDs before recompute to surface renames.
    const oldDerived = (cp.subgraphs ?? [])
      .filter((sg) => sg.derived)
      .map((sg) => ({ id: sg.id, nodes: sg.nodes.slice().sort() }));

    checkpoint = {
      ...applySubgraphs(cp, { tier: params.tier, strategy: params.strategy }),
      updatedAt: new Date().toISOString(),
    };

    const newDerived = (checkpoint!.subgraphs ?? [])
      .filter((sg) => sg.derived)
      .map((sg) => ({ id: sg.id, nodes: sg.nodes.slice().sort() }));

    // Detect renames: old derived whose member set is preserved but ID changed.
    const renamed: Array<{ from: string; to: string; nodes: string[] }> = [];
    for (const oldSg of oldDerived) {
      const oldKey = oldSg.nodes.join(",");
      const matched = newDerived.find((n) => n.nodes.join(",") === oldKey);
      if (matched && matched.id !== oldSg.id) {
        renamed.push({ from: oldSg.id, to: matched.id, nodes: oldSg.nodes });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            subgraphs: (checkpoint!.subgraphs ?? []).map((sg) =>
              summarizeSubgraph(sg, checkpoint!.graph)
            ),
            ...(renamed.length > 0 ? { renamed } : {}),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: add_subgraph
// ---------------------------------------------------------------------------

server.tool(
  "add_subgraph",
  `Declare an explicit subgraph with a stable slug, hierarchy, and completion/failure policies. Explicit subgraphs are preserved across compute_subgraphs runs. Slug becomes the subgraph ID — must match ${SUBGRAPH_SLUG_RE.source}, cannot be 'sg-lead' or start with 'auto-'.`,
  {
    slug: z.string().describe(
      "Stable subgraph identifier (also used as the ID). Lowercase letters, digits, hyphens, 1–41 chars, must start with a letter. Cannot be 'sg-lead' or start with 'auto-'.",
    ),
    nodeIds: z.array(z.string()).min(1).describe(
      "Member node IDs. Must exist in the graph; must not overlap any other explicit subgraph.",
    ),
    executor: z.nativeEnum(Executor).describe("LEAD or ADJUNCT"),
    label: z.string().optional().describe("Optional human-readable label"),
    parentId: z.string().optional().describe(
      "Optional parent subgraph ID for hierarchical nesting. Must reference an existing subgraph.",
    ),
    tier: z.nativeEnum(Tier).optional().describe(
      "Execution tier. Defaults to the checkpoint tier when omitted.",
    ),
    completionPolicy: z.nativeEnum(SubgraphCompletionPolicy).optional()
      .describe(
        "ALL (default) | ANY | GATED. GATED requires the gates field.",
      ),
    failurePolicy: z.nativeEnum(SubgraphFailurePolicy).optional().describe(
      "FAIL_FAST (default) | CONTINUE | BEST_EFFORT.",
    ),
    gates: z.array(
      z.union([
        z.string(),
        z.object({
          kind: z.literal("external"),
          source: z.string().min(1),
          externalId: z.string().min(1),
          url: z.string().optional(),
          taskId: z.string().optional(),
        }),
      ]),
    ).optional().describe(
      "Gate references required by GATED completion or BEST_EFFORT failure policies. Each entry is either a node ID (string, must be a member of nodeIds) or an external blocker object {kind:'external', source, externalId, url?, taskId?}.",
    ),
  },
  (params) => {
    const cp = requireCheckpoint();
    const tier = params.tier ?? cp.tier;
    if (!tier) {
      throw new Error(
        "Tier required — provide via add_subgraph or set on checkpoint via init.",
      );
    }

    // Idempotency is enforced inside `addSubgraph`: matching spec returns the
    // existing subgraph; differing spec returns an error. We detect the
    // idempotent-no-op case by checking pre-existence so we can surface the
    // `idempotent: true` signal to the caller without re-emitting the event.
    const wasPreExisting = (cp.subgraphs ?? []).some((sg) =>
      sg.id === params.slug
    );

    const result = addSubgraph(cp.graph, cp.subgraphs ?? [], {
      slug: params.slug,
      label: params.label,
      parentId: params.parentId,
      executor: params.executor,
      nodeIds: params.nodeIds,
      tier,
      completionPolicy: params.completionPolicy,
      failurePolicy: params.failurePolicy,
      gates: params.gates,
    });
    if (!result.ok) {
      throw new Error(`add_subgraph failed: ${result.error}`);
    }
    const sg = result.value!;

    if (wasPreExisting) {
      // Idempotent no-op — addSubgraph confirmed the spec matches the existing
      // subgraph. Do not re-emit the event or re-run subgraph derivation.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              subgraph: summarizeSubgraph(sg, cp.graph),
              idempotent: true,
            }),
          },
        ],
      };
    }

    // Stamp subgraph ID onto member nodes (graph mutation, not state machine concern)
    const updatedNodes = { ...cp.graph.nodes };
    for (const id of sg.nodes) {
      if (updatedNodes[id]) {
        updatedNodes[id] = { ...updatedNodes[id], subgraph: sg.id };
      }
    }

    // `transition` is the sole source of truth for cp.subgraphs mutation.
    // It appends the subgraph idempotently via the subgraph_added handler.
    const cpWithNodes: Checkpoint = {
      ...cp,
      graph: { ...cp.graph, nodes: updatedNodes },
      updatedAt: new Date().toISOString(),
    };
    const eventCp = transition(cpWithNodes, {
      type: "subgraph_added",
      subgraph: sg,
    });

    // Refresh derived sibling membership: any derived subgraph that previously
    // contained nodes now claimed by this explicit subgraph must shed them so
    // list_subgraphs / summarizeSubgraph do not report the same node twice.
    // applySubgraphs is a no-op when tier is unset.
    const nextCp = applySubgraphs(eventCp);
    checkpoint = nextCp;

    const finalSg = nextCp.subgraphs?.find((s) => s.id === sg.id) ?? sg;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            subgraph: summarizeSubgraph(finalSg, nextCp.graph),
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
    subgraphId: z.string().describe(
      "Subgraph ID — `sg-lead` (lead subgraph), `auto-<8-char-hash>` (derived adjunct), or a user-supplied slug (explicit).",
    ),
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
// Tool: list_subgraphs
// ---------------------------------------------------------------------------

server.tool(
  "list_subgraphs",
  "List all subgraphs in the current checkpoint, split into derived (auto-computed) and explicit (user-declared) partitions.",
  {},
  () => {
    const cp = requireCheckpoint();
    const all = cp.subgraphs ?? [];
    const derived = all.filter((sg) => sg.derived).map((sg) =>
      summarizeSubgraph(sg, cp.graph)
    );
    const explicit = all.filter((sg) => !sg.derived).map((sg) =>
      summarizeSubgraph(sg, cp.graph)
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, derived, explicit }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: materialize_plan
// ---------------------------------------------------------------------------

server.tool(
  "materialize_plan",
  "Render the full execution plan as a single human-readable document. Groups all nodes by subgraph: sg-lead first, then explicit subgraphs (sorted by slug), then derived subgraphs (sorted by auto-hash ID). Per-node: wave, type, status, readiness, repo, task, PR, tags. Supports markdown (default) and json output formats.",
  {
    format: z.enum(["markdown", "json"]).optional().default("markdown")
      .describe(
        'Output format: "markdown" (default, human-readable) or "json" (structured, for programmatic consumers).',
      ),
  },
  (params) => {
    const cp = requireCheckpoint();
    const rendered = materializePlan(cp, params.format);
    return {
      content: [
        {
          type: "text",
          text: rendered,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: saga_report
// ---------------------------------------------------------------------------

server.tool(
  "saga_report",
  "Generate a structured aggregate report after all saga nodes reach terminal status. Summarises convergence quality: total nodes, one-shot completions, retried convergences, failures, iteration statistics, escalations, and C7 node-summary records. Call this after the final `close_node` before `tasks_close`. Supports markdown (default) and json output formats. By default requires all nodes to be terminal; pass allowPartial: true to generate a partial report mid-saga.",
  {
    format: z.enum(["markdown", "json"]).optional().default("markdown")
      .describe(
        'Output format: "markdown" (default, human-readable) or "json" (structured, for programmatic consumers).',
      ),
    sessionLabel: z.string().optional().describe(
      "Session label used to filter C7 node-summary records from the brain. When omitted, nodeSummaries will be empty.",
    ),
    allowPartial: z.boolean().optional().describe(
      "When true, skips the terminal-saga precondition check and generates a partial report mid-execution. Defaults to false.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();
    const label = params.sessionLabel ?? cp.sessionLabel;

    // Precondition: all nodes must be terminal unless allowPartial is set.
    if (!params.allowPartial) {
      const allNodes = Object.values(cp.graph.nodes);
      const nonTerminal = allNodes.filter(
        (n) =>
          n.status !== NodeStatus.DONE &&
          n.status !== NodeStatus.MERGED &&
          n.status !== NodeStatus.FAILED,
      );
      if (nonTerminal.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                reason:
                  `saga not terminal — ${nonTerminal.length} of ${allNodes.length} nodes still pending or active`,
              }),
            },
          ],
        };
      }
    }

    // Fetch C7 node-summary records from the brain when a session label is available.
    const nodeSummaries: NodeSummaryEntry[] = [];
    if (label) {
      try {
        // records.list filtered by tag "node-summary"
        const listResp = await callBrainTool(brainExec, "records.list", {
          tag: "node-summary",
        });
        const listData = listResp as {
          records?: Array<{ id?: string; tags?: string[] }>;
          items?: Array<{ id?: string; tags?: string[] }>;
        };
        const records: Array<{ id?: string; tags?: string[] }> =
          listData.records ?? listData.items ?? [];

        // Filter to records that carry the session label tag.
        const sessionRecords = records.filter(
          (r) => Array.isArray(r.tags) && r.tags.includes(label),
        );

        for (const rec of sessionRecords) {
          if (!rec.id) continue;
          try {
            const content = await callBrainTool(
              brainExec,
              "records.fetch_content",
              {
                record_id: rec.id,
              },
            );
            const parsed = content as { text?: string; data?: string };
            const text: string = parsed.text ?? parsed.data ?? "";
            // Parse the C7 markdown template for key fields.
            const statusMatch = text.match(/\*\*Status:\*\*\s*(\S+)/);
            const commitsMatch = text.match(/\*\*Commits:\*\*\s*([^\n]+)/);
            const whatMatch = text.match(/\*\*What changed:\*\*\s*([^\n]+)/);
            const nodeIdMatch = text.match(/## Node Summary:\s*(\S+)/);
            nodeSummaries.push({
              nodeId: nodeIdMatch?.[1] ?? rec.id,
              status: statusMatch?.[1] ?? "unknown",
              commits: commitsMatch?.[1]
                ? commitsMatch[1].split(/[,\s]+/).filter(Boolean)
                : [],
              whatChanged: whatMatch?.[1] ?? "(no summary)",
            });
          } catch {
            // Skip unreadable records — best-effort aggregation.
          }
        }
      } catch {
        // Brain unavailable — proceed with empty summaries.
      }
    }

    const report = buildSagaReport(cp, nodeSummaries);
    const rendered = renderSagaReport(report, params.format);
    return {
      content: [
        {
          type: "text",
          text: rendered,
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
  "Activate all nodes in the specified wave and record it as the current wave. Continuous-frontier extension (UNM-1b7.5): also activates any PENDING+READY nodes from later waves whose dependencies have already cleared — ELICIT_GATE nodes in later waves are excluded to preserve gate-halted semantics. Cross-wave activations appear in `crossWaveActivated[]` in the response. Optional `capabilities` parameter enables capability-match gating (UNM-1b7.4): nodes whose `requirements` are not satisfied by the dispatcher's capabilities are rejected up-front with a concrete missing list. Omit `capabilities` to skip the check (backward-compatible unfenced dispatch).",
  {
    waveId: z.coerce.number().int().describe("Wave index to dispatch"),
    capabilities: z.object({
      repos: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      canWrite: z.boolean().optional(),
      humanPresent: z.boolean().optional(),
      labels: z.array(z.string()).optional(),
    }).optional().describe(
      "Dispatcher capabilities for capability-match gating. When provided, every node's `requirements` is checked via `validateDispatch`; mismatches are reported in the response under `capabilityMismatches[]`.",
    ),
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

    // Partition elicit gates from regular nodes
    const elicitGateIds = wave.nodes.filter(
      (nId) => cp.graph.nodes[nId]?.type === NodeType.ELICIT_GATE,
    );
    const regularNodeIds = wave.nodes.filter(
      (nId) => cp.graph.nodes[nId]?.type !== NodeType.ELICIT_GATE,
    );

    // Wave isolation: ELICIT_GATE nodes must not share a wave with other node types.
    // Validated first — before capability checks or brain round-trips.
    if (elicitGateIds.length > 0 && regularNodeIds.length > 0) {
      throw new Error(
        `Wave ${params.waveId} mixes ELICIT_GATE nodes (${
          elicitGateIds.join(", ")
        }) with regular nodes (${regularNodeIds.join(", ")}). ` +
          `ELICIT_GATE nodes must be in their own wave — use DEPENDS_ON edges to separate them.`,
      );
    }

    // Capability matching (UNM-1b7.4): if the caller advertises capabilities,
    // gate every regular node's requirements against them. Mismatches are
    // surfaced and the node is held back from activation. Backward-compat:
    // when `capabilities` is undefined, the check is skipped entirely.
    const capabilityMismatches: Array<{ nodeId: string; missing: string[] }> =
      [];
    const capabilityRejected = new Set<string>();
    if (params.capabilities) {
      for (const nId of regularNodeIds) {
        const result = validateDispatch(cp.graph, nId, params.capabilities);
        if (!result.ok) {
          // The validateDispatch error message includes the missing list;
          // re-derive the structured form via canDispatch for the response.
          const node = cp.graph.nodes[nId];
          const detail = canDispatch(params.capabilities, node?.requirements);
          if (!detail.ok) {
            capabilityMismatches.push({ nodeId: nId, missing: detail.missing });
            capabilityRejected.add(nId);
          }
        }
      }
    }

    // ---------------------------------------------------------------------------
    // At-cap FAILED pre-rejection: nodes that are FAILED and have exhausted
    // their iteration cap must not be re-dispatched. They are excluded from
    // activation and returned in capExhaustedNodes for the caller to handle.
    // ---------------------------------------------------------------------------
    const capExhaustedNodes: string[] = [];
    const capExhaustedRejected = new Set<string>();
    for (const nId of regularNodeIds) {
      if (capabilityRejected.has(nId)) continue;
      const node = cp.graph.nodes[nId];
      if (
        node?.status === NodeStatus.FAILED &&
        (node.iterationCount ?? 0) >= (node.maxIterations ?? 3)
      ) {
        capExhaustedNodes.push(nId);
        capExhaustedRejected.add(nId);
      }
    }

    // ---------------------------------------------------------------------------
    // UNM-1b7.7: External-blocker consultation
    //
    // Before activating each regular node, check whether its brain task has
    // unresolved external blockers. Nodes with blockers are NOT activated —
    // they are marked BLOCKED (readinessStatus) and collected in externalBlocked.
    // Brain CLI failures are treated as "no blockers" (graceful degradation).
    // This section runs BEFORE WorkPacket minting (Drone Delta's lease-fencing
    // section follows in a subsequent merge).
    // ---------------------------------------------------------------------------
    const externalBlocked: Array<{
      nodeId: string;
      blockers: ExternalBlockerSnapshot[];
    }> = [];
    const clearToActivate: string[] = [];

    // Mutable working copy of the checkpoint for stamping blocker snapshots.
    let workingCp = cp;

    for (const nId of regularNodeIds) {
      // Skip nodes already rejected by the capability gate (UNM-1b7.4) or
      // the at-cap FAILED pre-rejection above.
      // They should not be activated; they should not consume a brain
      // round-trip; they should not receive a fence.
      if (capabilityRejected.has(nId) || capExhaustedRejected.has(nId)) {
        continue;
      }
      const node = workingCp.graph.nodes[nId];
      if (!node?.taskId) {
        clearToActivate.push(nId);
        continue;
      }
      const { unresolvedCount, blockers } = await getExternalBlockers(
        node.taskId,
        brainExec,
      );
      if (unresolvedCount > 0) {
        // Stamp cached snapshot onto the node and mark `externallyBlocked`.
        // Do NOT touch `readinessStatus` — that's the topology axis, owned by
        // `recomputeReadiness`. `externallyBlocked` is the orthogonal axis
        // owned by this consultation; `currentFrontier` filters on both.
        workingCp = {
          ...workingCp,
          graph: {
            ...workingCp.graph,
            nodes: {
              ...workingCp.graph.nodes,
              [nId]: {
                ...node,
                externallyBlocked: true,
                externalBlockers: blockers,
              },
            },
          },
        };
        externalBlocked.push({ nodeId: nId, blockers });
      } else {
        // Clear the external-blocker axis explicitly. Stale resolved snapshots
        // are kept on the node for audit but `externallyBlocked` flips to false.
        workingCp = {
          ...workingCp,
          graph: {
            ...workingCp.graph,
            nodes: {
              ...workingCp.graph.nodes,
              [nId]: {
                ...node,
                externallyBlocked: false,
                externalBlockers: blockers.length > 0 ? blockers : undefined,
              },
            },
          },
        };
        clearToActivate.push(nId);
      }
    }

    // Continuous-frontier cross-wave activation (UNM-1b7.5): any PENDING+READY
    // node in a later wave whose deps have cleared is eligible for activation
    // now, not forced to wait for its own wave_dispatched call. ELICIT_GATE
    // nodes in later waves are excluded — they require their own wave dispatch
    // to preserve gate-halted semantics. External-blocker consultation mirrors
    // the target-wave loop above.
    const crossWaveActivated: string[] = [];
    if (elicitGateIds.length === 0) {
      const frontier = currentFrontier(workingCp.graph, workingCp.waves);
      const waveNodeSet = new Set(wave.nodes);
      for (const entry of frontier) {
        if (entry.wave <= params.waveId) continue; // only later waves
        if (waveNodeSet.has(entry.nodeId)) continue; // already handled
        const crossNode = workingCp.graph.nodes[entry.nodeId];
        if (!crossNode) continue;
        if (crossNode.type === NodeType.ELICIT_GATE) continue;
        // Capability check for cross-wave nodes
        if (params.capabilities) {
          const result = validateDispatch(
            workingCp.graph,
            entry.nodeId,
            params.capabilities,
          );
          if (!result.ok) continue;
        }
        // At-cap FAILED exclusion
        if (
          crossNode.status === NodeStatus.FAILED &&
          (crossNode.iterationCount ?? 0) >= (crossNode.maxIterations ?? 3)
        ) continue;
        // External-blocker consultation
        if (crossNode.taskId) {
          const { unresolvedCount, blockers } = await getExternalBlockers(
            crossNode.taskId,
            brainExec,
          );
          if (unresolvedCount > 0) {
            workingCp = {
              ...workingCp,
              graph: {
                ...workingCp.graph,
                nodes: {
                  ...workingCp.graph.nodes,
                  [entry.nodeId]: {
                    ...crossNode,
                    externallyBlocked: true,
                    externalBlockers: blockers,
                  },
                },
              },
            };
            externalBlocked.push({ nodeId: entry.nodeId, blockers });
            continue;
          }
          workingCp = {
            ...workingCp,
            graph: {
              ...workingCp.graph,
              nodes: {
                ...workingCp.graph.nodes,
                [entry.nodeId]: {
                  ...crossNode,
                  externallyBlocked: false,
                  externalBlockers: blockers.length > 0 ? blockers : undefined,
                },
              },
            },
          };
        }
        clearToActivate.push(entry.nodeId);
        crossWaveActivated.push(entry.nodeId);
      }
    }

    // Activate regular nodes; set elicit gates to BLOCKED with resolved schema
    let updatedGraph = activateNodes(workingCp.graph, clearToActivate);
    for (const gateId of elicitGateIds) {
      const gateNode = updatedGraph.nodes[gateId];
      if (gateNode) {
        updatedGraph = {
          ...updatedGraph,
          nodes: {
            ...updatedGraph.nodes,
            [gateId]: {
              ...gateNode,
              status: NodeStatus.BLOCKED,
              // Resolve default schema so clear_gate can always validate against it
              elicitSchema: gateNode.elicitSchema ?? approvalSchema(),
            },
          },
        };
      }
    }

    // Lease fencing (UNM-1b7.6): mint a fresh attemptId and increment leaseVersion
    // ONLY for nodes that were actually activated. Externally-blocked nodes are
    // kept PENDING and must NOT receive a fresh fence — otherwise they leak into
    // workPackets[] alongside externalBlocked[] and a caller could attempt to
    // mark progress on a node that was never dispatched.
    const workPackets: WorkPacket[] = [];
    for (const nId of clearToActivate) {
      const node = updatedGraph.nodes[nId];
      if (!node) continue;
      const attemptId = crypto.randomUUID();
      const leaseVersion = (node.leaseVersion ?? 0) + 1;
      updatedGraph = {
        ...updatedGraph,
        nodes: {
          ...updatedGraph.nodes,
          [nId]: { ...node, attemptId, leaseVersion },
        },
      };
      workPackets.push({ nodeId: nId, attemptId, leaseVersion });
    }

    const dispatchResult = await transitionWithEffects(
      { ...workingCp, graph: updatedGraph },
      { type: "wave_dispatched", waveId: params.waveId },
    );
    if (dispatchResult.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(dispatchResult.checkpoint);
    }

    // Enter gate_halted if this wave contains elicit gates
    checkpoint = elicitGateIds.length > 0
      ? { ...dispatchResult.checkpoint, machineState: MachineState.GATE_HALTED }
      : dispatchResult.checkpoint;

    // Compute per-node execution info and parallelism groups
    const activatedNodes = wave.nodes.filter(
      (nId) =>
        !externalBlocked.some((eb) => eb.nodeId === nId) &&
        !capabilityRejected.has(nId),
    );
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
            activatedNodes,
            machineState: checkpoint.machineState,
            nodeExecution,
            parallelBatches: batches,
            workPackets,
            ...(crossWaveActivated.length > 0 ? { crossWaveActivated } : {}),
            ...(externalBlocked.length > 0 ? { externalBlocked } : {}),
            ...(capabilityMismatches.length > 0
              ? { capabilityMismatches }
              : {}),
            ...(capExhaustedNodes.length > 0 ? { capExhaustedNodes } : {}),
            ...(elicitGateIds.length > 0
              ? {
                pendingElicitGates: elicitGateIds.map((nId) => ({
                  nodeId: nId,
                  prompt: checkpoint!.graph.nodes[nId]?.elicitPrompt,
                  schema: checkpoint!.graph.nodes[nId]?.elicitSchema,
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
// Tool: complete_node
// ---------------------------------------------------------------------------

server.tool(
  "complete_node",
  "Mark a node as completed. Status is derived from existing node metadata: PR_CREATED if prUrl is set (use update_node first), MERGED if node has a repo, DONE otherwise. Nodes with outgoing MERGE_GATE edges require prUrl/prNumber to be set via update_node before completion. Provide attemptId + leaseVersion (from dispatch_wave workPackets) to enable fence validation; omit both for backward-compatible unfenced writes.",
  {
    nodeId: z.string().describe("Node ID to complete"),
    attemptId: z.string().optional().describe(
      "Fence: attemptId from the WorkPacket issued at dispatch. Required when leaseVersion is provided.",
    ),
    leaseVersion: z.coerce.number().int().optional().describe(
      "Fence: leaseVersion from the WorkPacket issued at dispatch. Required when attemptId is provided.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();

    const node = cp.graph.nodes[params.nodeId];
    if (!node) {
      throw new Error(`Node "${params.nodeId}" not found in graph`);
    }

    // Lease fencing (UNM-1b7.6): validate fence if both fields are provided.
    // Backward compat: if neither is provided, the write proceeds unfenced.
    if (params.attemptId !== undefined && params.leaseVersion !== undefined) {
      if (
        node.attemptId !== params.attemptId ||
        node.leaseVersion !== params.leaseVersion
      ) {
        throw new Error(
          `Stale lease for node ${params.nodeId}: expected (attemptId=${node.attemptId}, leaseVersion=${node.leaseVersion}), got (attemptId=${params.attemptId}, leaseVersion=${params.leaseVersion})`,
        );
      }
    }

    // Guard: ELICIT_GATE nodes must be cleared via clear_gate, not completed directly
    if (
      node.type === NodeType.ELICIT_GATE && node.elicitResponse === undefined
    ) {
      throw new Error(
        `ELICIT_GATE node "${params.nodeId}" has not been cleared — use clear_gate to collect the user response first`,
      );
    }

    // Guard: all incoming dependencies must be satisfied before completion
    const unsatisfied = unsatisfiedDependencies(cp.graph, params.nodeId);
    if (unsatisfied.length > 0) {
      throw new Error(
        `Cannot complete node "${params.nodeId}" — unsatisfied dependencies: ${
          unsatisfied.map((u) =>
            `${u.edge.from} → ${u.edge.to} (${u.edge.type}): ${u.reason}`
          ).join("; ")
        }`,
      );
    }

    // Enforce PR reference on nodes with outgoing MERGE_GATE edges
    const hasMergeGateOut = cp.graph.edges.some(
      (e) => e.from === params.nodeId && e.type === EdgeType.MERGE_GATE,
    );
    if (hasMergeGateOut && (!node.prUrl || !node.prNumber)) {
      throw new Error(
        `Node "${params.nodeId}" has outgoing MERGE_GATE edges — set prUrl and prNumber via update_node first`,
      );
    }

    const check = canTransition(cp, {
      type: "node_completed",
      nodeId: params.nodeId,
    });
    if (!check.allowed) {
      throw new Error(`Cannot complete node: ${check.reason}`);
    }

    const updatedGraph = completeNode(cp.graph, params.nodeId);
    const completeResult = await transitionWithEffects(
      { ...cp, graph: updatedGraph },
      {
        type: "node_completed",
        nodeId: params.nodeId,
      },
    );
    checkpoint = completeResult.checkpoint;
    if (completeResult.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(checkpoint);
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
// Tool: update_node
// ---------------------------------------------------------------------------

server.tool(
  "update_node",
  "Update metadata on a node without changing its status. Use to attach PR info (prUrl, prNumber) before calling complete_node. Provide attemptId + leaseVersion (from dispatch_wave workPackets) to enable fence validation; omit both for backward-compatible unfenced writes.",
  {
    nodeId: z.string().describe("Node ID to update"),
    prUrl: z.string().optional().describe("URL of the pull request"),
    prNumber: z.coerce.number().int().optional().describe(
      "Pull request number",
    ),
    attemptId: z.string().optional().describe(
      "Fence: attemptId from the WorkPacket issued at dispatch. Required when leaseVersion is provided.",
    ),
    leaseVersion: z.coerce.number().int().optional().describe(
      "Fence: leaseVersion from the WorkPacket issued at dispatch. Required when attemptId is provided.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();

    const updateTarget = cp.graph.nodes[params.nodeId];
    if (!updateTarget) {
      throw new Error(`Node "${params.nodeId}" not found in graph`);
    }

    // Lease fencing (UNM-1b7.6): validate fence if both fields are provided.
    if (params.attemptId !== undefined && params.leaseVersion !== undefined) {
      if (
        updateTarget.attemptId !== params.attemptId ||
        updateTarget.leaseVersion !== params.leaseVersion
      ) {
        throw new Error(
          `Stale lease for node ${params.nodeId}: expected (attemptId=${updateTarget.attemptId}, leaseVersion=${updateTarget.leaseVersion}), got (attemptId=${params.attemptId}, leaseVersion=${params.leaseVersion})`,
        );
      }
    }

    const patch: { prUrl?: string; prNumber?: number } = {};
    if (params.prUrl !== undefined) patch.prUrl = params.prUrl;
    if (params.prNumber !== undefined) patch.prNumber = params.prNumber;

    const updatedGraph = updateNode(cp.graph, params.nodeId, patch);
    checkpoint = {
      ...cp,
      graph: updatedGraph,
      updatedAt: new Date().toISOString(),
    };
    await saveCheckpointToBrain(checkpoint);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            prUrl: checkpoint.graph.nodes[params.nodeId]?.prUrl,
            prNumber: checkpoint.graph.nodes[params.nodeId]?.prNumber,
            status: checkpoint.graph.nodes[params.nodeId]?.status,
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: close_node
// ---------------------------------------------------------------------------

server.tool(
  "close_node",
  "Close a node's brain task. Node must be in a completed status (DONE, MERGED, or PR_CREATED with merged PR). Fails loudly on error.",
  {
    nodeId: z.string().describe("Node ID to close"),
  },
  async (params) => {
    const cp = requireCheckpoint();

    const node = cp.graph.nodes[params.nodeId];
    const guard = closeNodeGuard(node, params.nodeId);
    if (!guard.ok) {
      throw new Error(guard.error);
    }
    // closeNodeGuard.ok === true implies node and node.taskId are defined.
    const taskId = node!.taskId!;

    // Close the task — single integration surface via brainExec. A pre-flight
    // existence probe was removed (unm-17c): it duplicated I/O and drifted
    // from the canonical CLI subcommand surface. `tasks close` fails loudly
    // if the task is missing; the error bubbles to the caller intact.
    const cwd = repoRoot(node!.repo);
    await brainExec.exec(BRAIN_CLI, ["tasks", "close", taskId], {
      timeout: 5000,
      ...(cwd ? { cwd } : {}),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            taskId,
            closed: true,
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
  "Mark a node as failed with a human-readable reason. Provide attemptId + leaseVersion (from dispatch_wave workPackets) to enable fence validation; omit both for backward-compatible unfenced writes.",
  {
    nodeId: z.string().describe("Node ID to fail"),
    reason: z.string().describe("Human-readable failure reason"),
    attemptId: z.string().optional().describe(
      "Fence: attemptId from the WorkPacket issued at dispatch. Required when leaseVersion is provided.",
    ),
    leaseVersion: z.coerce.number().int().optional().describe(
      "Fence: leaseVersion from the WorkPacket issued at dispatch. Required when attemptId is provided.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();

    // Guard: BLOCKED gate nodes cannot be failed directly — clear or cancel the wave
    const failTarget = cp.graph.nodes[params.nodeId];
    if (
      failTarget?.status === NodeStatus.BLOCKED && (
        failTarget.type === NodeType.ELICIT_GATE ||
        cp.graph.edges.some((e) =>
          e.to === params.nodeId && e.type === EdgeType.MERGE_GATE
        )
      )
    ) {
      throw new Error(
        `Node "${params.nodeId}" is BLOCKED by a gate — use clear_gate or cancel instead of fail_node`,
      );
    }

    // Guard: PENDING nodes have not been dispatched — they cannot have failed
    if (failTarget?.status === NodeStatus.PENDING) {
      throw new Error(
        `Cannot fail node "${params.nodeId}" — node is PENDING and has not been dispatched`,
      );
    }

    // Lease fencing (UNM-1b7.6): validate fence if both fields are provided.
    if (params.attemptId !== undefined && params.leaseVersion !== undefined) {
      if (
        failTarget?.attemptId !== params.attemptId ||
        failTarget?.leaseVersion !== params.leaseVersion
      ) {
        throw new Error(
          `Stale lease for node ${params.nodeId}: expected (attemptId=${failTarget?.attemptId}, leaseVersion=${failTarget?.leaseVersion}), got (attemptId=${params.attemptId}, leaseVersion=${params.leaseVersion})`,
        );
      }
    }

    const check = canTransition(cp, {
      type: "node_failed",
      nodeId: params.nodeId,
      reason: params.reason,
    });
    if (!check.allowed) {
      throw new Error(`Cannot fail node: ${check.reason}`);
    }

    const updatedGraph = failNode(cp.graph, params.nodeId, params.reason);
    const failResult = await transitionWithEffects(
      { ...cp, graph: updatedGraph },
      { type: "node_failed", nodeId: params.nodeId, reason: params.reason },
    );
    checkpoint = failResult.checkpoint;
    if (failResult.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(checkpoint);
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
          const waveFailResult = await transitionWithEffects(checkpoint, {
            type: "wave_failed",
            waveId: wave.id,
          });
          checkpoint = waveFailResult.checkpoint;
          if (waveFailResult.shouldSaveCheckpoint) {
            await saveCheckpointToBrain(checkpoint);
          }
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

    const elicitResult = await elicitForm(
      message,
      triageSchema({
        decisionTitle: "Triage decision",
        contextTitle: "Additional context (optional)",
      }),
    );

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

    // decline or cancel — return failure data without triage decision
    const noCapability = elicitResult.action === "decline" &&
      !server.server.getClientCapabilities()?.elicitation;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...failureData,
            triageSkipped: true,
            ...(noCapability
              ? { reason: "Client lacks elicitation capability." }
              : {}),
          }),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: reset_node
// ---------------------------------------------------------------------------

server.tool(
  "reset_node",
  "Transition a FAILED node back to PENDING, bumping leaseVersion to invalidate any in-flight WorkPackets. Completes the convergence loop's retry path. Provide attemptId + leaseVersion to enable fence validation; omit both for backward-compatible unfenced writes.",
  {
    nodeId: z.string().describe("Node ID to reset"),
    reason: z.string().optional().describe(
      "Human-readable reason for the reset (recorded in the event log).",
    ),
    resetIterationCount: z.boolean().optional().describe(
      "If true, resets iterationCount to 0. Otherwise preserves the current count so the cap still bites on next failure.",
    ),
    attemptId: z.string().optional().describe(
      "Fence: attemptId from the WorkPacket issued at dispatch. Required when leaseVersion is provided.",
    ),
    leaseVersion: z.coerce.number().int().optional().describe(
      "Fence: leaseVersion from the WorkPacket issued at dispatch. Required when attemptId is provided.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();

    const resetTarget = cp.graph.nodes[params.nodeId];
    if (!resetTarget) {
      throw new Error(`Node "${params.nodeId}" not found in checkpoint`);
    }

    // Idempotency: if already PENDING with the same leaseVersion, return ok without re-resetting.
    if (resetTarget.status === NodeStatus.PENDING) {
      const sameVersion = params.leaseVersion === undefined ||
        resetTarget.leaseVersion === params.leaseVersion;
      if (sameVersion) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                idempotent: true,
                nodeId: params.nodeId,
                leaseVersion: resetTarget.leaseVersion,
              }),
            },
          ],
        };
      }
      // PENDING but leaseVersion mismatch — stale fence.
      throw new Error(
        `Stale lease for node ${params.nodeId}: expected leaseVersion=${resetTarget.leaseVersion}, got leaseVersion=${params.leaseVersion}`,
      );
    }

    // Precondition: only FAILED nodes may be reset (non-PENDING, non-FAILED path)
    if (resetTarget.status !== NodeStatus.FAILED) {
      throw new Error(
        `Cannot reset node "${params.nodeId}" — node is ${resetTarget.status} (still being executed), expected ${NodeStatus.FAILED}. Wait for completion or call fail_node first.`,
      );
    }

    // Lease fencing: validate fence if both fields are provided
    if (params.attemptId !== undefined && params.leaseVersion !== undefined) {
      if (
        resetTarget.attemptId !== params.attemptId ||
        resetTarget.leaseVersion !== params.leaseVersion
      ) {
        throw new Error(
          `Stale lease for node ${params.nodeId}: expected (attemptId=${resetTarget.attemptId}, leaseVersion=${resetTarget.leaseVersion}), got (attemptId=${params.attemptId}, leaseVersion=${params.leaseVersion})`,
        );
      }
    }

    const check = canTransition(cp, {
      type: "node_reset",
      nodeId: params.nodeId,
      reason: params.reason,
      resetIterationCount: params.resetIterationCount,
    });
    if (!check.allowed) {
      throw new Error(`Cannot reset node: ${check.reason}`);
    }

    const resetResult = await transitionWithEffects(cp, {
      type: "node_reset",
      nodeId: params.nodeId,
      reason: params.reason,
      resetIterationCount: params.resetIterationCount,
    });
    checkpoint = resetResult.checkpoint;
    if (resetResult.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(checkpoint);
    }

    const updatedNode = checkpoint.graph.nodes[params.nodeId];
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            status: updatedNode?.status,
            leaseVersion: updatedNode?.leaseVersion,
            iterationCount: updatedNode?.iterationCount,
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
  "Clear a gate on a node. For MERGE_GATE: verifies PR is merged via gh CLI before clearing. For ELICIT_GATE: pass the user's structured response. Auto-advances to dispatching if all gates cleared.",
  {
    nodeId: z.string().describe("Node ID to clear gate for"),
    response: z.record(z.unknown()).optional().describe(
      "Structured response from user elicitation. Required for ELICIT_GATE nodes.",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();

    const check = canTransition(cp, {
      type: "gate_cleared",
      nodeId: params.nodeId,
    });
    if (!check.allowed) {
      throw new Error(`Cannot clear gate: ${check.reason}`);
    }

    // Check if this node is gated by a MERGE_GATE edge — verify PR merge status
    const mergeGateEdges = cp.graph.edges.filter(
      (e) => e.to === params.nodeId && e.type === EdgeType.MERGE_GATE,
    );

    for (const edge of mergeGateEdges) {
      const sourceNode = cp.graph.nodes[edge.from];
      if (!sourceNode) continue;

      if (!sourceNode.prUrl || !sourceNode.prNumber) {
        throw new Error(
          `Source node "${edge.from}" of MERGE_GATE has no PR reference — cannot verify merge status`,
        );
      }

      // Extract owner/repo from PR URL (e.g., https://github.com/owner/repo/pull/123)
      const prUrlMatch = sourceNode.prUrl.match(
        /github\.com\/([^/]+\/[^/]+)\/pull\//,
      );
      if (!prUrlMatch) {
        throw new Error(
          `Cannot parse repository from PR URL: ${sourceNode.prUrl}`,
        );
      }
      const repoSlug = prUrlMatch[1];

      try {
        const { stdout } = await execFileAsync("gh", [
          "pr",
          "view",
          String(sourceNode.prNumber),
          "--repo",
          repoSlug,
          "--json",
          "state",
        ], { timeout: 10000 });
        const prState = JSON.parse(stdout);
        if (prState.state !== "MERGED") {
          throw new Error(
            `PR #${sourceNode.prNumber} in ${repoSlug} is not merged (state: ${prState.state}). Cannot clear merge gate.`,
          );
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("Cannot clear merge gate")
        ) {
          throw err;
        }
        throw new Error(
          `Failed to verify merge status for PR #${sourceNode.prNumber}: ${err}`,
        );
      }

      // Update source node status to MERGED since PR is confirmed merged
      if (sourceNode.status !== NodeStatus.MERGED) {
        checkpoint = {
          ...cp,
          graph: {
            ...cp.graph,
            nodes: {
              ...cp.graph.nodes,
              [edge.from]: { ...sourceNode, status: NodeStatus.MERGED },
            },
          },
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // Validate response against elicitSchema for ELICIT_GATE nodes
    const cpForTransition = checkpoint ?? cp;
    const gateNode = cpForTransition.graph.nodes[params.nodeId];
    if (
      gateNode?.type === NodeType.ELICIT_GATE && gateNode.elicitSchema &&
      params.response
    ) {
      const response = params.response;
      const schemaProps = Object.keys(gateNode.elicitSchema.properties);
      const responseKeys = Object.keys(response);
      const unknownKeys = responseKeys.filter((k) => !schemaProps.includes(k));
      if (unknownKeys.length > 0) {
        throw new Error(
          `Response contains keys not in elicitSchema: ${
            unknownKeys.join(", ")
          }`,
        );
      }
      const missingRequired = (gateNode.elicitSchema.required ?? []).filter(
        (k) => !(k in response),
      );
      if (missingRequired.length > 0) {
        throw new Error(
          `Response missing required fields: ${missingRequired.join(", ")}`,
        );
      }
    }

    // Apply gate_cleared via state machine with effects
    const gateResult = await transitionWithEffects(cpForTransition, {
      type: "gate_cleared",
      nodeId: params.nodeId,
      response: params.response,
    });
    if (gateResult.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(gateResult.checkpoint);
    }

    // Also update the graph via the pure graph helper
    const updatedGraph = clearGate(gateResult.checkpoint.graph, params.nodeId);
    checkpoint = { ...gateResult.checkpoint, graph: updatedGraph };

    const node = checkpoint.graph.nodes[params.nodeId];
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            nodeId: params.nodeId,
            machineState: checkpoint.machineState,
            ...(node?.elicitResponse !== undefined
              ? { elicitResponse: node.elicitResponse }
              : {}),
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
    reason: z.string().optional().describe(
      "Human-readable cancellation reason",
    ),
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
    const elicitMessage = `Cancel trimatrix execution?\n\n` +
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

    // Cancellation is user-initiated — optimistic degradation: proceed if client lacks capability
    const proceedWithoutApproval = elicitResult.action === "decline" &&
      !server.server.getClientCapabilities()?.elicitation;

    if (!proceedWithoutApproval) {
      if (
        elicitResult.action === "decline" || elicitResult.action === "cancel"
      ) {
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

    // Lease-fence invalidation for cancel lives in the `cancel` transition
    // (state.ts) so event-log replay reproduces the bump.
    const cancelResult = await transitionWithEffects(cp, {
      type: "cancel",
      reason: params.reason,
    });
    checkpoint = cancelResult.checkpoint;
    if (cancelResult.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(checkpoint);
    }
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
// Tool: complete
// ---------------------------------------------------------------------------

server.tool(
  "complete",
  "Complete the trimatrix execution. Transitions from dispatching or failed to completed state and persists a final checkpoint. Returns node status summary with warnings for any non-terminal nodes.",
  {},
  async () => {
    const cp = requireCheckpoint();
    const check = canTransition(cp, { type: "execution_completed" });
    if (!check.allowed) throw new Error(`Cannot complete: ${check.reason}`);

    const TERMINAL_STATUSES = new Set([
      NodeStatus.DONE,
      NodeStatus.MERGED,
      NodeStatus.PR_CREATED,
      NodeStatus.FAILED,
    ]);
    const nodes = Object.values(cp.graph.nodes);
    const statusCounts: Record<string, number> = {};
    const nonTerminalNodes: Array<
      { id: string; label: string; status: string }
    > = [];

    for (const node of nodes) {
      statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1;
      if (!TERMINAL_STATUSES.has(node.status)) {
        nonTerminalNodes.push({
          id: node.id,
          label: node.label,
          status: node.status,
        });
      }
    }

    const warnings: string[] = [];
    if (nonTerminalNodes.length > 0) {
      warnings.push(
        `${nonTerminalNodes.length} node(s) in non-terminal state: ${
          nonTerminalNodes.map((n) => `${n.id}(${n.status})`).join(", ")
        }`,
      );
    }

    const result = await transitionWithEffects(cp, {
      type: "execution_completed",
    });
    checkpoint = result.checkpoint;
    if (result.shouldSaveCheckpoint) {
      await saveCheckpointToBrain(checkpoint);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            machineState: checkpoint.machineState,
            sessionId: checkpoint.sessionId,
            sessionLabel: checkpoint.sessionLabel,
            nodeCount: nodes.length,
            statusCounts,
            waveCount: checkpoint.waves.length,
            ...(warnings.length > 0 ? { warnings } : {}),
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
    artifactId: z.string().describe(
      "Brain artifact ID of the checkpoint to archive",
    ),
    reason: z.string().optional().describe("Archival reason"),
  },
  async (params) => {
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
        `Failed to archive artifact: ${
          err instanceof Error ? err.message : String(err)
        }`,
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

    if (cp.machineState === MachineState.GATE_HALTED) {
      const gates = pendingGates(cp);
      const elicitGates = gates.filter(
        (nId) => cp.graph.nodes[nId]?.type === NodeType.ELICIT_GATE,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              wave: null,
              reason: elicitGates.length > 0
                ? "Machine is gate_halted. Pending elicitation gates require user input."
                : "Machine is gate_halted. Clear all merge gates before proceeding.",
              pendingGates: gates,
              ...(elicitGates.length > 0
                ? {
                  pendingElicitGates: elicitGates.map((nId) => ({
                    nodeId: nId,
                    prompt: cp.graph.nodes[nId]?.elicitPrompt,
                    schema: cp.graph.nodes[nId]?.elicitSchema,
                  })),
                }
                : {}),
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
        return `  - ${node.id} | repo: ${
          node.repo ?? "single-repo"
        } | ${node.label} | branch: ${node.worktreeBranch ?? "n/a"}`;
      })
      .join("\n");

    const message = `Wave ${wave.id + 1} is ready for dispatch.\n` +
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

    // decline (explicit rejection or missing elicitation capability)
    if (elicitResult.action === "decline") {
      const noCapability = !server.server.getClientCapabilities()?.elicitation;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              reason: noCapability
                ? "Client lacks elicitation capability. Wave requires manual approval."
                : "Wave rejected by user.",
              machineState: cp.machineState,
            }),
          },
        ],
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
// Tool: next_frontier (UNM-1b7.5)
// ---------------------------------------------------------------------------

server.tool(
  "next_frontier",
  "Return the continuous frontier — every PENDING + READY node across all waves whose dependencies have cleared, regardless of wave order. The frontier crosses wave boundaries: a wave-3 node whose deps are satisfied appears even when wave-1 is incomplete. Filters out nodes flagged `externallyBlocked` (orthogonal axis from `readinessStatus`). Returns batches grouped by wave for downstream batching/UI. Advisory only — `dispatch_wave` remains the authoritative activation point.",
  {},
  () => {
    const cp = requireCheckpoint();
    const frontier = currentFrontier(cp.graph, cp.waves);
    const batches = nextFrontierBatch(cp.graph, cp.waves, cp.currentWaveId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            frontier,
            batches,
            // algorithmVersion: callers compare this against a cached value to
            // detect when the frontier algorithm changed and cached results must
            // be discarded. Sourced from Checkpoint.algorithmVersion, set to
            // GRAPH_ALGORITHM_VERSION at session init.
            algorithmVersion: cp.algorithmVersion,
            advisoryNote:
              "Frontier is advisory. dispatch_wave is the authoritative activation point and may reject nodes the frontier listed (stale fence, fresh external blocker, capability mismatch).",
          }),
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
          readinessStatus: node.readinessStatus ?? "READY",
          repo: node.repo,
          label: node.label,
          type: node.type,
          prUrl: node.prUrl,
          prNumber: node.prNumber,
          failureReason: node.failureReason,
          ...(node.elicitPrompt ? { elicitPrompt: node.elicitPrompt } : {}),
          ...(node.elicitResponse
            ? { elicitResponse: node.elicitResponse }
            : {}),
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
                subgraphs: cp.subgraphs.map((sg) =>
                  summarizeSubgraph(sg, cp.graph)
                ),
              }
              : {}),
            ...(cp.cancellationReason
              ? { cancellationReason: cp.cancellationReason }
              : {}),
            ...(cp.cancelledAt ? { cancelledAt: cp.cancelledAt } : {}),
            ...(cp.machineState === MachineState.GATE_HALTED
              ? {
                pendingElicitGates: pendingGates(cp)
                  .filter(
                    (nId) => cp.graph.nodes[nId]?.type === NodeType.ELICIT_GATE,
                  )
                  .map((nId) => ({
                    nodeId: nId,
                    prompt: cp.graph.nodes[nId]?.elicitPrompt,
                    schema: cp.graph.nodes[nId]?.elicitSchema,
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
// Tool: rename_session
// ---------------------------------------------------------------------------

server.tool(
  "rename_session",
  "Update the session label of the active in-memory graph. Use after plan approval to give the session a human-readable name before checkpointing.",
  {
    sessionLabel: z.string().min(1).describe(
      "New human-readable session label (e.g., 'auth-middleware-refactor').",
    ),
  },
  (params) => {
    if (checkpoint === null) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "No active session to rename",
            }),
          },
        ],
      };
    }
    checkpoint.sessionLabel = params.sessionLabel;
    checkpoint.updatedAt = new Date().toISOString();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            sessionId: checkpoint.sessionId,
            sessionLabel: checkpoint.sessionLabel,
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
  "List all trimatrix sessions: the active in-memory session (if any) plus persisted checkpoint sessions across all brains.",
  {},
  async () => {
    type CheckpointEntry = {
      recordId: string;
      title: string;
      updatedAt: string;
    };
    type SessionEntry = {
      sessionId: string;
      brain: string;
      machineState: string | null;
      checkpoints: CheckpointEntry[];
      createdAt: string;
      updatedAt: string;
    };

    const result: {
      ok: boolean;
      active: {
        sessionId: string;
        sessionLabel: string;
        machineState: string;
        intent?: string;
        tier?: string;
        repos: string[];
        nodeCount: number;
        currentWaveId: number | null;
        updatedAt: string;
      } | null;
      persisted: SessionEntry[];
      errors: string[];
    } = { ok: true, active: null, persisted: [], errors: [] };

    // Active in-memory session
    if (checkpoint !== null) {
      result.active = {
        sessionId: checkpoint.sessionId ?? "unknown",
        sessionLabel: checkpoint.sessionLabel ?? "unnamed",
        machineState: checkpoint.machineState,
        ...(checkpoint.intent ? { intent: checkpoint.intent } : {}),
        ...(checkpoint.tier ? { tier: checkpoint.tier } : {}),
        repos: checkpoint.repos.map((r) => r.name),
        nodeCount: Object.keys(checkpoint.graph.nodes).length,
        currentWaveId: checkpoint.currentWaveId,
        updatedAt: checkpoint.updatedAt,
      };
    }

    // Build prefix → brain name map (best-effort)
    const prefixMap = new Map<string, string>();
    try {
      const { stdout: lsOut } = await execFileAsync("brain", ["ls", "--json"]);
      const brains: { brains: Array<{ name: string; prefix: string }> } = JSON
        .parse(lsOut);
      for (const b of brains.brains) prefixMap.set(b.prefix, b.name);
    } catch {
      // Best-effort — brain field falls back to raw prefix
    }

    function brainFromRecordId(recordId: string): string {
      const prefix = recordId.split("-")[0];
      return prefixMap.get(prefix) ?? prefix;
    }

    // Single unscoped query against unified DB — returns all brains' checkpoints
    const home = Deno.env.get("HOME") ?? "";
    const unifiedDb = join(home, ".brain", "brain.db");
    const sessionRe = /^\[session:([^\]]+)\]\s*/;

    try {
      const { stdout } = await execFileAsync("brain", [
        "--sqlite-db",
        unifiedDb,
        "snapshots",
        "list",
        "--tag",
        "trimatrix-checkpoint",
        "--json",
      ]);
      const data = JSON.parse(stdout);
      const records: Array<{
        record_id: string;
        title: string;
        updated_at: number;
      }> = data.snapshots ?? data;

      // Group by session ID extracted from title prefix [session:<id>]
      const sessionMap = new Map<
        string,
        { brain: string; checkpoints: CheckpointEntry[] }
      >();

      for (const record of records) {
        const match = record.title.match(sessionRe);
        const sessionKey = match ? match[1] : "untagged";
        const displayTitle = match
          ? record.title.slice(match[0].length)
          : record.title;
        if (!sessionMap.has(sessionKey)) {
          // Brain attribution uses the first record's prefix; cross-brain
          // sessions (rare) will only report the originating brain.
          sessionMap.set(sessionKey, {
            brain: brainFromRecordId(record.record_id),
            checkpoints: [],
          });
        }
        sessionMap.get(sessionKey)!.checkpoints.push({
          recordId: record.record_id,
          title: displayTitle,
          updatedAt: new Date(record.updated_at * 1000).toISOString(),
        });
      }

      const TERMINAL_STATES = new Set(["completed", "cancelled"]);

      result.persisted = Array.from(sessionMap.entries())
        .map(([sessionId, { brain, checkpoints }]) => {
          const dates = checkpoints.map((c) => c.updatedAt).sort();
          // Extract machineState from the latest checkpoint title
          // Title format: checkpoint:<sessionId>:wave-<waveId>:<machineState>
          const latest = checkpoints.reduce((
            a,
            b,
          ) => (a.updatedAt > b.updatedAt ? a : b));
          const titleParts = latest.title.split(":");
          const machineState = titleParts.length >= 4
            ? titleParts[titleParts.length - 1]
            : null;
          return {
            sessionId,
            brain,
            machineState,
            checkpoints,
            createdAt: dates[0],
            updatedAt: dates[dates.length - 1],
          };
        })
        .filter((s) => !s.machineState || !TERMINAL_STATES.has(s.machineState));
    } catch (e) {
      result.errors.push(
        `snapshot query failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Sort: most recently updated first
    result.persisted.sort((a, b) =>
      b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0
    );

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
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
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

/** Real BrainExec wired to execWithStdin / execFileAsync. */
const brainExec: BrainExec = {
  withStdin: execWithStdin,
  exec(cmd, args, opts) {
    return execFileAsync(cmd, args, {
      timeout: opts?.timeout,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
  },
};

// ---------------------------------------------------------------------------
// Side-effect runner (wired to brainExec + mutable event log writer)
// ---------------------------------------------------------------------------

// Mutable deps object — logWriter is set when a session initializes so all
// subsequent transitionWithEffects calls write to the file-based event log.
const effectDeps = { brainExec, logWriter: undefined as EventLogWriter | undefined };
const transitionWithEffects = createEffectRunner(effectDeps);

/**
 * Persist the current checkpoint to brain snapshots (best-effort).
 * Called when the side-effect runner signals shouldSaveCheckpoint.
 */
async function saveCheckpointToBrain(cp: Checkpoint): Promise<void> {
  try {
    const serialized = JSON.stringify(cp);
    const waveId = cp.currentWaveId ?? "latest";
    const sessionId = cp.sessionId ?? "unknown";
    const title =
      `[session:${sessionId}] checkpoint:${sessionId}:wave-${waveId}:${cp.machineState}`;
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "records_save_snapshot",
        arguments: {
          title,
          text: serialized,
          tags: [
            "trimatrix-checkpoint",
            `trimatrix-session:${cp.sessionId ?? "unknown"}`,
            `state:${cp.machineState}`,
          ],
        },
      },
      id: 1,
    });
    await brainExec.withStdin("brain", ["mcp"], rpc, 10000);
  } catch (err) {
    console.error("[trimatrix] checkpoint save failed:", err);
  }
}

/**
 * Resolve the filesystem root for a node's repo from the checkpoint.
 * Delegates to the pure repoRootLookup in brain-sync.ts.
 */
function repoRoot(repoName?: string): string | undefined {
  if (!checkpoint) return undefined;
  return repoRootLookup(checkpoint.repos, repoName);
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
      "tasks",
      "list",
      "--json",
      `--status=${status}`,
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
      "tasks",
      "list",
      "--json",
      "--blocked",
    ], { timeout: 5000 });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    return [];
  } catch {
    return [];
  }
}

async function readJsonFile(
  path: string,
): Promise<Record<string, unknown> | null> {
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
      const key = COLUMN_KEY_MAP[col.toLowerCase()] ??
        col.toLowerCase().replace(/ /g, "_");
      return String((t as unknown as Record<string, unknown>)[key] ?? "-");
    });
    return "| " + cells.join(" | ") + " |";
  });
  return [header, sep, ...rows].join("\n");
}

function formatAgents(agentsState: Record<string, unknown>): string {
  const active = (agentsState.active ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
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
  sections.push(
    `# Post-Compaction Checkpoint (compaction #${opts.compactionNum})`,
  );

  if (opts.tasksInProgress.length > 0) {
    sections.push("\n## In-Progress Tasks");
    sections.push(
      formatTaskTable(opts.tasksInProgress, [
        "ID",
        "Title",
        "Status",
        "Assignee",
        "Priority",
      ]),
    );
  }
  if (opts.tasksOpen.length > 0) {
    sections.push("\n## Open Tasks");
    sections.push(
      formatTaskTable(opts.tasksOpen, [
        "ID",
        "Title",
        "Status",
        "Assignee",
        "Priority",
      ]),
    );
  }
  if (opts.tasksBlocked.length > 0) {
    sections.push("\n## Blocked Tasks");
    sections.push(
      formatTaskTable(opts.tasksBlocked, ["ID", "Title", "Status", "Priority"]),
    );
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
  if (totalTime > 0) {
    statsParts.push(`Subagent time: ${Math.floor(totalTime)}s`);
  }

  const nActive = opts.agentsState
    ? Object.keys((opts.agentsState.active ?? {}) as Record<string, unknown>)
      .length
    : 0;
  const taskSummary: string[] = [];
  if (opts.tasksInProgress.length > 0) {
    taskSummary.push(`${opts.tasksInProgress.length} in-progress`);
  }
  if (opts.tasksOpen.length > 0) {
    taskSummary.push(`${opts.tasksOpen.length} open`);
  }
  if (opts.tasksBlocked.length > 0) {
    taskSummary.push(`${opts.tasksBlocked.length} blocked`);
  }
  if (nActive > 0) taskSummary.push(`${nActive} subagents active`);
  if (taskSummary.length > 0) {
    statsParts.push("Tasks: " + taskSummary.join(", "));
  }

  sections.push("\n## Session Stats");
  sections.push(statsParts.join(" | "));

  // Recommend action if there are tasks but no active subagents
  const hasWork = opts.tasksInProgress.length > 0 || opts.tasksOpen.length > 0;
  const hasAgents = nActive > 0;
  if (hasWork && !hasAgents) {
    sections.push("\n## Recommended Action");
    sections.push(
      "Subagents were lost during compaction. Resume with the task ID — " +
        "dispatch drones for the remaining tasks.",
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
      "snapshots",
      "save",
      "--stdin",
      "--title",
      title,
      ...tagArgs,
      "--media-type",
      "text/markdown",
    ], content);
  } catch {
    // Best-effort — do not fail the tool call
  }
}

// ---------------------------------------------------------------------------
// Task status sync helpers
// ---------------------------------------------------------------------------

/**
 * Search brain's episodic memory for prior episodes (best-effort).
 */
function searchPriorEpisodes(
  query: string,
  tags?: string[],
  brains?: string[],
  budget?: number,
  cwd?: string,
) {
  return searchEpisodesCore(query, tags, brains, budget, cwd, brainExec);
}

// ---------------------------------------------------------------------------
// Tool: add_external_blocker
// ---------------------------------------------------------------------------

server.tool(
  "add_external_blocker",
  "Add an external blocker to the brain task associated with a graph node. The node must have a taskId set.",
  {
    nodeId: z.string().describe(
      "Node ID whose brain task receives the blocker",
    ),
    source: z.string().describe(
      "Source system identifier (e.g. 'jira', 'github-pr', 'linear')",
    ),
    externalId: z.string().describe("Identifier within the source system"),
    url: z.string().optional().describe("Optional URL for human navigation"),
  },
  async (params) => {
    const cp = requireCheckpoint();
    const node = cp.graph.nodes[params.nodeId];
    if (!node) {
      throw new Error(`Node "${params.nodeId}" not found in graph`);
    }
    if (!node.taskId) {
      throw new Error(
        `Node "${params.nodeId}" has no taskId — cannot add external blocker. Set taskId via update_node first.`,
      );
    }
    const result = await callBrainTool(brainExec, "tasks.apply_event", {
      task_id: node.taskId,
      event: {
        type: "external_blocker_added",
        source: params.source,
        externalId: params.externalId,
        ...(params.url ? { url: params.url } : {}),
      },
    }, { timeout: 5000 });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            buildExternalBlockerResponse(
              node.taskId,
              params.externalId,
              result,
            ),
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: resolve_external_blocker
// ---------------------------------------------------------------------------

server.tool(
  "resolve_external_blocker",
  "Resolve an external blocker on the brain task associated with a graph node. The node must have a taskId set.",
  {
    nodeId: z.string().describe(
      "Node ID whose brain task has the blocker resolved",
    ),
    source: z.string().describe(
      "Source system identifier matching the blocker to resolve",
    ),
    externalId: z.string().describe(
      "Identifier within the source system matching the blocker to resolve",
    ),
  },
  async (params) => {
    const cp = requireCheckpoint();
    const node = cp.graph.nodes[params.nodeId];
    if (!node) {
      throw new Error(`Node "${params.nodeId}" not found in graph`);
    }
    if (!node.taskId) {
      throw new Error(
        `Node "${params.nodeId}" has no taskId — cannot resolve external blocker. Set taskId via update_node first.`,
      );
    }
    const result = await callBrainTool(brainExec, "tasks.apply_event", {
      task_id: node.taskId,
      event: {
        type: "external_blocker_resolved",
        source: params.source,
        externalId: params.externalId,
      },
    }, { timeout: 5000 });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            buildExternalBlockerResponse(
              node.taskId,
              params.externalId,
              result,
            ),
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: reflect_session
// ---------------------------------------------------------------------------

server.tool(
  "reflect_session",
  "Gather session episodes and return reflection source material for synthesis. Requires an active checkpoint with a sessionId.",
  {},
  async () => {
    const cp = requireCheckpoint();
    if (!cp.sessionId) {
      throw new Error(
        "No sessionId on checkpoint — cannot gather session episodes.",
      );
    }

    const sessionTag = `session:${cp.sessionId}`;
    const episodes = await searchPriorEpisodes(
      cp.sessionLabel ?? cp.sessionId,
      [sessionTag],
      undefined,
      2000,
    );

    const nodeCount = Object.keys(cp.graph.nodes).length;
    const completedCount = Object.values(cp.graph.nodes).filter(
      (n) => n.status === NodeStatus.DONE || n.status === NodeStatus.MERGED,
    ).length;
    const failedCount = Object.values(cp.graph.nodes).filter(
      (n) => n.status === NodeStatus.FAILED,
    ).length;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            sessionId: cp.sessionId,
            sessionLabel: cp.sessionLabel,
            intent: cp.intent,
            tier: cp.tier,
            machineState: cp.machineState,
            nodeCount,
            completedCount,
            failedCount,
            waveCount: cp.waves.length,
            episodeIds: cp.episodeIds ?? [],
            episodes,
            ...(episodes.length === 0 && (cp.episodeIds ?? []).length === 0
              ? {
                note:
                  "No episodes recorded during this session. Nothing to reflect on.",
              }
              : {
                reflectionPrompt:
                  `Synthesize a reflection for session "${
                    cp.sessionLabel ?? cp.sessionId
                  }". ` +
                  `Summarize key decisions, obstacles encountered, and lessons learned. ` +
                  `Use memory_reflect with mode="commit" to persist the reflection, ` +
                  `linking to source episode IDs: [${
                    (cp.episodeIds ?? []).join(", ")
                  }].`,
              }),
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
  "Serialize the current checkpoint to a JSON string for persistence. Always captures graph state, brain tasks, and saves a brain snapshot. When runtime_state_key is provided, also captures /tmp state files (agents, costs, compactions) as optional enrichment.",
  {
    runtime_state_key: z.string().optional().describe(
      "Key for locating /tmp runtime state files (e.g. Claude Code session ID). Enables capture of agent/cost/compaction state as optional enrichment.",
    ),
    // Backward compatibility: accept claude_session_id as alias
    claude_session_id: z.string().optional().describe(
      "Deprecated — use runtime_state_key instead. Kept for backward compatibility.",
    ),
  },
  async (params) => {
    if (!checkpoint) {
      throw new Error(
        "No checkpoint loaded. Call init or restore_checkpoint first.",
      );
    }

    const graphJson = serialize(checkpoint);

    const result: Record<string, unknown> = {
      checkpoint: graphJson,
      sessionId: checkpoint.sessionId ?? undefined,
      sessionLabel: checkpoint.sessionLabel ?? undefined,
    };

    // Always query brain tasks
    const [tasksInProgress, tasksOpen, tasksBlocked] = await Promise.all([
      queryBrainTasks("in_progress"),
      queryBrainTasks("open"),
      queryBrainBlockedTasks(),
    ]);

    // Runtime state files — optional enrichment keyed by runtime_state_key
    const runtimeKey = params.runtime_state_key ?? params.claude_session_id;
    let agentsState: Record<string, unknown> | null = null;
    let costsState: Record<string, unknown> | null = null;
    let compactionsState: Record<string, unknown> | null = null;

    if (runtimeKey) {
      [agentsState, costsState, compactionsState] = await Promise.all([
        readJsonFile(join(STATE_DIR, `unimatrix-agents-${runtimeKey}.json`)),
        readJsonFile(join(STATE_DIR, `unimatrix-costs-${runtimeKey}.json`)),
        readJsonFile(
          join(STATE_DIR, `unimatrix-compactions-${runtimeKey}.json`),
        ),
      ]);
    }

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

    // Save brain snapshot — always
    const snapshotTags = ["trimatrix-checkpoint", "compaction-checkpoint"];
    if (checkpoint.sessionId) {
      snapshotTags.push(`trimatrix-session:${checkpoint.sessionId}`);
    }

    const parts: string[] = [];
    if (checkpoint.sessionLabel) parts.push(checkpoint.sessionLabel);
    parts.push(`Compaction #${compactionNum}`);
    const counts: string[] = [];
    if (tasksInProgress.length > 0) {
      counts.push(`${tasksInProgress.length} in-progress`);
    }
    if (tasksOpen.length > 0) counts.push(`${tasksOpen.length} open`);
    if (tasksBlocked.length > 0) counts.push(`${tasksBlocked.length} blocked`);
    if (counts.length > 0) parts.push(counts.join(", "));
    parts.push("graph attached");

    const titlePrefix = checkpoint.sessionId
      ? `[session:${checkpoint.sessionId}] `
      : "";
    const title = titlePrefix + parts.join(" — ");

    await saveBrainSnapshot(title, snapshotTags, markdown);

    result.capturedState = {
      tasksInProgress: tasksInProgress.length,
      tasksOpen: tasksOpen.length,
      tasksBlocked: tasksBlocked.length,
      hasAgents: agentsState !== null,
      hasCosts: costsState !== null,
      hasGraph: true,
      compactionNum,
    };

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
  async (params) => {
    const cp = deserialize(params.checkpoint);
    const validStates = Object.values(MachineState) as string[];
    if (!validStates.includes(cp.machineState)) {
      throw new Error(
        `Checkpoint has invalid machineState "${cp.machineState}". Valid states: ${
          validStates.join(", ")
        }`,
      );
    }
    if (
      typeof cp.graph.nodes !== "object" ||
      cp.graph.nodes === null ||
      Array.isArray(cp.graph.nodes)
    ) {
      throw new Error(
        `Checkpoint has malformed graph.nodes — expected a record, got ${
          Array.isArray(cp.graph.nodes) ? "array" : typeof cp.graph.nodes
        }`,
      );
    }

    // Validate checkpoint against the file-based event log when available.
    // Best-effort — validation failure is logged but never blocks restore.
    let logValidation: { valid: boolean; reason?: string } = { valid: true };
    if (cp.sessionId) {
      const writer = new EventLogWriter(cp.sessionId);
      const logEntries = await writer.readAll();
      if (logEntries.length > 0) {
        logValidation = validateCheckpointAgainstLog(cp, logEntries);
        if (!logValidation.valid) {
          console.error(
            `[trimatrix/restore] event log validation failed: ${logValidation.reason}`,
          );
        }
      }
      // Re-activate the log writer so subsequent transitions continue appending.
      effectDeps.logWriter = writer;
    }

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
            logValidation,
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
    count: z.coerce.number().int().min(1).max(12).describe(
      "Number of agents to generate designations for (1–12)",
    ),
    role: z.nativeEnum(Role)
      .optional()
      .describe("Agent role (determines Borg functional title)"),
    trimatrix: z.boolean().optional().describe(
      "If true, use 'Trimatrix <random>' as unit instead of 'Unimatrix Zero'",
    ),
    trimatrix_id: z.coerce.number().int().min(1).max(999).optional().describe(
      "Pin a specific Trimatrix ID instead of generating a random one",
    ),
  },
  (params) => {
    // Resolve trimatrix_id: explicit override wins; otherwise derive from session;
    // fall back to random with a warning when no session is active.
    let resolvedTrimatrixId = params.trimatrix_id;
    if (resolvedTrimatrixId === undefined && params.trimatrix) {
      const sessionId = checkpoint?.sessionId;
      if (sessionId) {
        // sessionId-only derivation; see deriveTrimatrixId comment for the gitCommit rationale.
        resolvedTrimatrixId = deriveTrimatrixId(sessionId);
      } else {
        console.error(
          "[trimatrix/designate] No active session — trimatrix_id will be random. " +
            "Call init or restore_checkpoint first for deterministic IDs.",
        );
      }
    }
    const result = designate(
      params.count,
      params.role as Role | undefined,
      params.trimatrix,
      resolvedTrimatrixId,
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
            error:
              `'${ref}' is not a registered brain and not a valid directory`,
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
    const cp = requireCheckpoint();
    const repoExists = cp.repos.some((r) => r.name === params.name);
    if (!repoExists) {
      throw new Error(
        `Brain "${params.name}" not found in checkpoint repos. ` +
          `Available: ${cp.repos.map((r) => r.name).join(", ") || "(none)"}. ` +
          `Register via add_repo first.`,
      );
    }

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
