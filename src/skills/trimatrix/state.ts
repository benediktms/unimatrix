/**
 * State machine for trimatrix execution lifecycle and checkpoint serialization.
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { Checkpoint, Event, EventLogEntry, Graph, Intent, Node, RepoMetadata, RoutingTrace, Subgraph, SubgraphStrategy, Tier } from "./types.ts";
import {
  Executor,
  MachineState,
  NodeStatus,
  ReadinessStatus,
  SubgraphCompletionPolicy,
  SubgraphFailurePolicy,
} from "./types.ts";
import { computeWaves, recomputeReadiness } from "./graph.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "2.7.0";

/** All checkpoint versions this runtime can load. */
const SUPPORTED_VERSIONS = new Set([
  "1.0.0",
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "2.0.0",
  "2.1.0",
  "2.2.0",
  "2.3.0",
  "2.4.0",
  "2.5.0",
  "2.6.0",
  "2.7.0",
]);

// ---------------------------------------------------------------------------
// Checkpoint creation
// ---------------------------------------------------------------------------

/**
 * Create a fresh checkpoint in the `initializing` state.
 * Computes execution waves from the provided graph.
 */
export function createCheckpoint(
  repos: RepoMetadata[],
  graph: Graph,
  opts?: {
    sessionId?: string;
    sessionLabel?: string;
    intent?: Intent;
    tier?: Tier;
    subgraphStrategy?: SubgraphStrategy;
    routingTrace?: RoutingTrace;
  },
): Checkpoint {
  const now = new Date().toISOString();
  // Defensive: callers may pass a graph whose nodes lack `readinessStatus`
  // (older fixtures, manually-constructed test graphs). Backfill `READY` and
  // recompute against edge satisfaction so the checkpoint starts coherent.
  // Also backfill 2.7.0 iteration fields (iterationCount / maxIterations) so
  // manually-constructed test fixtures do not have to thread these defaults.
  const initialGraph = recomputeReadiness({
    ...graph,
    nodes: Object.fromEntries(
      Object.entries(graph.nodes).map(([id, node]) => [
        id,
        {
          ...(node.readinessStatus !== undefined
            ? node
            : { ...node, readinessStatus: ReadinessStatus.READY }),
          iterationCount: node.iterationCount ?? 0,
          maxIterations: node.maxIterations ?? 3,
        },
      ]),
    ),
  });
  return {
    version: VERSION,
    machineState: MachineState.INITIALIZING,
    graph: initialGraph,
    waves: computeWaves(initialGraph),
    currentWaveId: null,
    repos,
    waveHistory: [],
    refinementHistory: [],
    createdAt: now,
    updatedAt: now,
    subgraphs: [],
    episodeIds: [],
    eventLog: [],
    ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts?.sessionLabel !== undefined
      ? { sessionLabel: opts.sessionLabel }
      : {}),
    ...(opts?.intent !== undefined ? { intent: opts.intent } : {}),
    ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts?.subgraphStrategy !== undefined
      ? { subgraphStrategy: opts.subgraphStrategy }
      : {}),
    ...(opts?.routingTrace !== undefined
      ? { routingTrace: opts.routingTrace }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

/**
 * Validate whether an event is legal given the checkpoint's current state.
 * Returns `{ allowed: true }` when the transition is valid, or
 * `{ allowed: false, reason: "..." }` when it is not.
 */
export function canTransition(
  checkpoint: Checkpoint,
  event: Event,
): { allowed: boolean; reason?: string } {
  const { machineState } = checkpoint;

  switch (event.type) {
    case "plan_submitted":
      if (machineState !== MachineState.INITIALIZING) {
        return {
          allowed: false,
          reason:
            `plan_submitted requires initializing state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "plan_finalized":
      if (machineState !== MachineState.PLAN_REVIEW) {
        return {
          allowed: false,
          reason:
            `plan_finalized requires plan_review state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "plan_revision_requested":
      if (machineState !== MachineState.PLAN_REVIEW) {
        return {
          allowed: false,
          reason:
            `plan_revision_requested requires plan_review state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "wave_dispatched":
    case "node_completed":
    case "node_failed":
    case "wave_completed":
    case "wave_failed":
    case "review_passed":
    case "review_failed":
      if (machineState !== MachineState.DISPATCHING) {
        return {
          allowed: false,
          reason:
            `${event.type} requires dispatching state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "execution_completed":
      if (machineState !== MachineState.DISPATCHING && machineState !== MachineState.FAILED) {
        return {
          allowed: false,
          reason:
            `execution_completed requires dispatching or failed state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "gate_cleared":
      if (machineState !== MachineState.GATE_HALTED) {
        return {
          allowed: false,
          reason:
            `gate_cleared requires gate_halted state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "retry_wave":
      if (machineState !== MachineState.FAILED) {
        return {
          allowed: false,
          reason: `retry_wave requires failed state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "refine":
      if (
        machineState !== MachineState.DISPATCHING &&
        machineState !== MachineState.GATE_HALTED &&
        machineState !== MachineState.FAILED
      ) {
        return {
          allowed: false,
          reason:
            `refine requires dispatching, gate_halted, or failed state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "refinement_approved":
      if (machineState !== MachineState.REFINING) {
        return {
          allowed: false,
          reason:
            `refinement_approved requires refining state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "subgraph_added":
      // Adding an explicit subgraph is legal in any pre-terminal state — it
      // declares structure, not state. Forbid only after completion/cancellation.
      if (
        machineState === MachineState.COMPLETED ||
        machineState === MachineState.CANCELLED
      ) {
        return {
          allowed: false,
          reason:
            `subgraph_added is not allowed in terminal state ${machineState}`,
        };
      }
      return { allowed: true };

    case "cancel":
      if (machineState === MachineState.COMPLETED || machineState === MachineState.CANCELLED) {
        return {
          allowed: false,
          reason: `cancel is not allowed in terminal state ${machineState}`,
        };
      }
      return { allowed: true };

    default: {
      const exhaustive: never = event;
      return {
        allowed: false,
        reason: `Unknown event type: ${(exhaustive as Event).type}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Transition application
// ---------------------------------------------------------------------------

/**
 * Apply an event to a checkpoint, returning a new immutable checkpoint.
 * Throws if the transition is not allowed.
 */
export function transition(checkpoint: Checkpoint, event: Event): Checkpoint {
  const check = canTransition(checkpoint, event);
  if (!check.allowed) {
    throw new Error(
      `Illegal transition — event "${event.type}" in state "${checkpoint.machineState}": ${check.reason}`,
    );
  }

  const now = new Date().toISOString();

  switch (event.type) {
    case "plan_submitted":
      return {
        ...checkpoint,
        machineState: MachineState.PLAN_REVIEW,
        updatedAt: now,
      };

    case "plan_finalized":
      return {
        ...checkpoint,
        machineState: MachineState.DISPATCHING,
        updatedAt: now,
      };

    case "plan_revision_requested":
      return {
        ...checkpoint,
        machineState: MachineState.INITIALIZING,
        updatedAt: now,
      };

    case "wave_dispatched":
      return {
        ...checkpoint,
        currentWaveId: event.waveId,
        updatedAt: now,
      };

    case "node_completed": {
      const node = checkpoint.graph.nodes[event.nodeId] as Node | undefined;
      if (!node) return { ...checkpoint, updatedAt: now };
      const updatedNode: Node = {
        ...node,
        status: node.prUrl ? NodeStatus.PR_CREATED : (node.repo ? NodeStatus.MERGED : NodeStatus.DONE),
      };
      const nextGraph = recomputeReadiness({
        ...checkpoint.graph,
        nodes: {
          ...checkpoint.graph.nodes,
          [event.nodeId]: updatedNode,
        },
      });
      return {
        ...checkpoint,
        graph: nextGraph,
        updatedAt: now,
      };
    }

    case "node_failed": {
      const node = checkpoint.graph.nodes[event.nodeId];
      if (!node) return { ...checkpoint, updatedAt: now };
      const updatedNode: Node = {
        ...node,
        status: NodeStatus.FAILED,
        failureReason: event.reason,
      };
      const nextGraph = recomputeReadiness({
        ...checkpoint.graph,
        nodes: {
          ...checkpoint.graph.nodes,
          [event.nodeId]: updatedNode,
        },
      });
      return {
        ...checkpoint,
        graph: nextGraph,
        updatedAt: now,
      };
    }

    case "wave_completed": {
      const wave = checkpoint.waves.find((w) => w.id === event.waveId);
      const isLastWave = event.waveId === checkpoint.waves.length;

      if (wave?.hasMergeGate && !isLastWave) {
        // Gate halt — pause execution for merge confirmation
        return {
          ...checkpoint,
          machineState: MachineState.GATE_HALTED,
          updatedAt: now,
        };
      }

      if (isLastWave) {
        return {
          ...checkpoint,
          machineState: MachineState.COMPLETED,
          updatedAt: now,
        };
      }

      return { ...checkpoint, updatedAt: now };
    }

    case "wave_failed":
      return {
        ...checkpoint,
        machineState: MachineState.FAILED,
        updatedAt: now,
      };

    case "execution_completed":
      return {
        ...checkpoint,
        machineState: MachineState.COMPLETED,
        updatedAt: now,
      };

    case "gate_cleared": {
      // Mark the node as active to clear its blocked state
      const node = checkpoint.graph.nodes[event.nodeId];
      const updatedGraph = node
        ? recomputeReadiness({
          ...checkpoint.graph,
          nodes: {
            ...checkpoint.graph.nodes,
            [event.nodeId]: {
              ...node,
              status: NodeStatus.ACTIVE,
              failureReason: undefined,
              ...(event.response !== undefined
                ? { elicitResponse: event.response }
                : {}),
            },
          },
        })
        : checkpoint.graph;

      // Check whether all pending gates in the current wave are cleared
      const allGatesCleared = pendingGates({
        ...checkpoint,
        graph: updatedGraph,
      }).length === 0;

      return {
        ...checkpoint,
        graph: updatedGraph,
        machineState: allGatesCleared ? MachineState.DISPATCHING : MachineState.GATE_HALTED,
        updatedAt: now,
      };
    }

    case "retry_wave":
      return {
        ...checkpoint,
        machineState: MachineState.DISPATCHING,
        currentWaveId: event.waveId,
        updatedAt: now,
      };

    case "refine": {
      // Lease-fence invalidation lives in the transition (not the server tool)
      // so event-log replay reproduces the bump. Every node's `leaseVersion`
      // is incremented by 1, invalidating any in-flight WorkPackets — the
      // contract is global re-fencing on refinement, conservative-safe.
      const refinedNodes: Record<string, Node> = {};
      for (const [nId, node] of Object.entries(checkpoint.graph.nodes)) {
        refinedNodes[nId] = { ...node, leaseVersion: (node.leaseVersion ?? 0) + 1 };
      }
      return {
        ...checkpoint,
        graph: { ...checkpoint.graph, nodes: refinedNodes },
        machineState: MachineState.REFINING,
        updatedAt: now,
      };
    }

    case "refinement_approved":
      return {
        ...checkpoint,
        machineState: MachineState.DISPATCHING,
        updatedAt: now,
      };

    case "review_passed": {
      const node = checkpoint.graph.nodes[event.nodeId] as Node | undefined;
      if (!node) return { ...checkpoint, updatedAt: now };
      // Derive target status matching complete_node logic
      const passedStatus = node.prUrl
        ? (node.repo ? NodeStatus.MERGED : NodeStatus.PR_CREATED)
        : NodeStatus.DONE;
      const updatedNode: Node = {
        ...node,
        status: passedStatus,
        lastReviewVerdict: "PASS",
        ...(event.reviewNotes !== undefined
          ? { lastReviewNotes: event.reviewNotes }
          : {}),
      };
      const nextGraph = recomputeReadiness({
        ...checkpoint.graph,
        nodes: {
          ...checkpoint.graph.nodes,
          [event.nodeId]: updatedNode,
        },
      });
      // Detect saga completion: all nodes in terminal status
      const terminalStatuses = new Set<NodeStatus>([
        NodeStatus.DONE,
        NodeStatus.MERGED,
        NodeStatus.PR_CREATED,
        NodeStatus.FAILED,
      ]);
      const allTerminal = Object.values(nextGraph.nodes).every((n) =>
        terminalStatuses.has(n.status)
      );
      return {
        ...checkpoint,
        graph: nextGraph,
        machineState: allTerminal ? MachineState.COMPLETED : checkpoint.machineState,
        updatedAt: now,
      };
    }

    case "review_failed": {
      const node = checkpoint.graph.nodes[event.nodeId] as Node | undefined;
      if (!node) return { ...checkpoint, updatedAt: now };
      const newIterationCount = (node.iterationCount ?? 0) + 1;
      const cap = node.maxIterations ?? 3;
      const capExhausted = newIterationCount >= cap;
      const updatedNode: Node = capExhausted
        ? {
          ...node,
          status: NodeStatus.FAILED,
          iterationCount: newIterationCount,
          lastReviewVerdict: "FAIL",
          failureReason:
            `iteration cap exhausted: review failed ${newIterationCount}/${cap} times`,
          ...(event.reviewNotes !== undefined
            ? { lastReviewNotes: event.reviewNotes }
            : {}),
        }
        : {
          ...node,
          status: NodeStatus.ACTIVE,
          iterationCount: newIterationCount,
          lastReviewVerdict: "FAIL",
          ...(event.reviewNotes !== undefined
            ? { lastReviewNotes: event.reviewNotes }
            : {}),
        };
      const nextGraph = recomputeReadiness({
        ...checkpoint.graph,
        nodes: {
          ...checkpoint.graph.nodes,
          [event.nodeId]: updatedNode,
        },
      });
      return {
        ...checkpoint,
        graph: nextGraph,
        updatedAt: now,
      };
    }

    case "subgraph_added": {
      /**
       * Allowed in any non-terminal state including INITIALIZING and PLAN_REVIEW.
       * Explicit subgraphs declared pre-finalize survive `finalize_plan` because
       * `applySubgraphs` (called by `finalize_plan`) preserves explicit subgraphs
       * and recomputes derived only over the unclaimed-node set.
       *
       * Idempotent: if a subgraph with the same `id` already exists in
       * `cp.subgraphs`, the transition is a no-op (just bumps `updatedAt`).
       * This makes the event safe under replay AND under repeated emission.
       */
      const existing = (checkpoint.subgraphs ?? []).find(
        (sg) => sg.id === event.subgraph.id,
      );
      if (existing) {
        // Idempotent no-op — subgraph already present, only bump timestamp
        return { ...checkpoint, updatedAt: now };
      }
      return {
        ...checkpoint,
        subgraphs: [...(checkpoint.subgraphs ?? []), event.subgraph],
        updatedAt: now,
      };
    }

    case "cancel": {
      // Lease-fence invalidation lives in the transition so event-log replay
      // reproduces the bump. Only PENDING / ACTIVE nodes carry in-flight
      // WorkPackets worth invalidating; terminal nodes are left untouched.
      const cancelledNodes: Record<string, Node> = {};
      for (const [nId, node] of Object.entries(checkpoint.graph.nodes)) {
        if (node.status === NodeStatus.PENDING || node.status === NodeStatus.ACTIVE) {
          cancelledNodes[nId] = { ...node, leaseVersion: (node.leaseVersion ?? 0) + 1 };
        } else {
          cancelledNodes[nId] = node;
        }
      }
      return {
        ...checkpoint,
        graph: { ...checkpoint.graph, nodes: cancelledNodes },
        machineState: MachineState.CANCELLED,
        cancellationReason: event.reason,
        cancelledAt: now,
        updatedAt: now,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a checkpoint to a JSON string.
 */
export function serialize(checkpoint: Checkpoint): string {
  return JSON.stringify(checkpoint);
}

/**
 * Deserialize a JSON string to a Checkpoint.
 * Throws if the JSON is malformed or the schema version is unsupported.
 */
export function deserialize(json: string): Checkpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Checkpoint deserialization failed — invalid JSON: ${err}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof (parsed as Record<string, unknown>).version !== "string"
  ) {
    throw new Error(
      "Checkpoint deserialization failed — missing or invalid version field",
    );
  }

  const cp = parsed as Checkpoint;
  if (!SUPPORTED_VERSIONS.has(cp.version)) {
    throw new Error(
      `Checkpoint version unsupported — supported: ${[...SUPPORTED_VERSIONS].join(", ")}, got ${cp.version}`,
    );
  }

  // Backward compat: 1.0.0 checkpoints lack refinementHistory — default to [].
  if (cp.version === "1.0.0") {
    cp.refinementHistory ??= [];
  }

  // Backward compat: 1.2.0 and earlier checkpoints lack repos — default to [].
  if (!cp.repos) cp.repos = [];

  // Backward compat: sessionId, sessionLabel, cancellationReason, and cancelledAt
  // are optional fields introduced in 1.2.0. Older checkpoints simply omit them —
  // no patching required since all four are typed as optional on Checkpoint.

  // Backward compat: 2.0.0 fields — subgraphs, intent, tier, subgraphStrategy,
  // and per-node executor. Pre-2.0.0 checkpoints lack these.
  if (!cp.subgraphs) cp.subgraphs = [];
  for (const node of Object.values(cp.graph.nodes)) {
    if ((node as unknown as { executor?: string }).executor === undefined) {
      // deno-lint-ignore no-explicit-any
      (node as any).executor = Executor.LEAD;
    }
  }

  // Backward compat: pre-2.3.0 checkpoints lack episodeIds — default to [].
  if (!cp.episodeIds) cp.episodeIds = [];

  // Backward compat: pre-2.4.0 subgraphs lack derived/policies. Older subgraphs
  // were always auto-derived with implicit ALL/FAIL_FAST semantics — restore those.
  for (const sg of (cp.subgraphs ?? []) as Subgraph[]) {
    const partial = sg as Partial<Subgraph>;
    if (partial.derived === undefined) sg.derived = true;
    if (!sg.completionPolicy) sg.completionPolicy = SubgraphCompletionPolicy.ALL;
    if (!sg.failurePolicy) sg.failurePolicy = SubgraphFailurePolicy.FAIL_FAST;
  }

  // Backward compat: pre-2.5.0 nodes lack readinessStatus. Default to READY,
  // then recompute against actual edge satisfaction so an old checkpoint
  // resumes with topology consistency.
  let needsReadinessRecompute = false;
  for (const node of Object.values(cp.graph.nodes)) {
    if ((node as Partial<Node>).readinessStatus === undefined) {
      // deno-lint-ignore no-explicit-any
      (node as any).readinessStatus = ReadinessStatus.READY;
      needsReadinessRecompute = true;
    }
  }
  if (needsReadinessRecompute) {
    cp.graph = recomputeReadiness(cp.graph);
  }

  // Backward compat: pre-2.6.0 checkpoints lack eventLog — default to [].
  // They cannot replay (the log was not written), but they round-trip cleanly.
  if (!cp.eventLog) cp.eventLog = [];

  // Backward compat: pre-2.7.0 nodes lack iterationCount / maxIterations.
  // Default iterationCount to 0 (no iterations attempted) and maxIterations to
  // 3 (the convergence-loop cap). Optional at the type level; backfilled here
  // for loaded checkpoints and by `addNode` in graph.ts for fresh creations.
  for (const node of Object.values(cp.graph.nodes)) {
    const n = node as Partial<Node>;
    if (n.iterationCount === undefined) {
      // deno-lint-ignore no-explicit-any
      (node as any).iterationCount = 0;
    }
    if (n.maxIterations === undefined) {
      // deno-lint-ignore no-explicit-any
      (node as any).maxIterations = 3;
    }
  }

  return cp;
}

// ---------------------------------------------------------------------------
// Event-log persistence
// ---------------------------------------------------------------------------

/**
 * Apply an event to a checkpoint AND append the event to the checkpoint's
 * event log. Returns a new immutable checkpoint with the log entry appended.
 *
 * The `transition` function itself remains pure and does NOT write to the log;
 * the log is opt-in via this function.
 *
 * Invariant: after a sequence of `appendEvent` calls,
 *   `serialize(replay(checkpoint.eventLog)) === serialize(checkpoint)`
 *
 * @param checkpoint - Current checkpoint (must have `eventLog` initialized).
 * @param event      - Event to apply and record.
 * @returns New checkpoint with the transition applied and the entry logged.
 */
export function appendEvent(checkpoint: Checkpoint, event: Event): Checkpoint {
  const next = transition(checkpoint, event);
  const prevLog = checkpoint.eventLog ?? [];
  const seq = prevLog.length + 1;
  const entry: EventLogEntry = {
    seq,
    timestamp: new Date().toISOString(),
    event,
    checkpointVersion: VERSION,
  };
  return {
    ...next,
    eventLog: [...prevLog, entry],
  };
}

/**
 * Reconstruct a checkpoint by replaying an ordered event log from left to right.
 *
 * Starting from `initial` (or a fresh empty checkpoint when absent), each
 * event is applied via `transition`. The seq values are validated for
 * monotonicity and gaplessness — any out-of-order or missing entry throws.
 *
 * @param events  - Ordered event log (must be gapless, starting at seq 1).
 * @param initial - Optional starting checkpoint. Defaults to a fresh empty
 *                  checkpoint when absent.
 * @returns The checkpoint produced after applying all events.
 * @throws If seq values are out-of-order, if a gap exists, or if any
 *         transition is rejected by the state machine.
 */
export function replay(
  events: EventLogEntry[],
  initial?: Checkpoint,
): Checkpoint {
  const now = new Date().toISOString();
  let cp: Checkpoint = initial ?? {
    version: VERSION,
    machineState: MachineState.INITIALIZING,
    graph: { nodes: {}, edges: [] },
    waves: [],
    currentWaveId: null,
    repos: [],
    waveHistory: [],
    refinementHistory: [],
    createdAt: now,
    updatedAt: now,
    subgraphs: [],
    episodeIds: [],
    eventLog: [],
  };

  for (let i = 0; i < events.length; i++) {
    const entry = events[i];
    const expectedSeq = i + 1;
    if (entry.seq !== expectedSeq) {
      throw new Error(
        `Event log replay failed — out-of-order seq: expected ${expectedSeq}, got ${entry.seq} at index ${i}`,
      );
    }
    cp = transition(cp, entry.event);
  }

  return { ...cp, eventLog: events };
}

// ---------------------------------------------------------------------------
// Helper queries
// ---------------------------------------------------------------------------

/**
 * Return the currently active wave, or null if none is set.
 */
export function currentWave(
  checkpoint: Checkpoint,
): typeof checkpoint.waves[0] | null {
  if (checkpoint.currentWaveId === null) return null;
  return checkpoint.waves.find((w) => w.id === checkpoint.currentWaveId) ??
    null;
}

/**
 * Return all node IDs whose status is FAILED across the entire graph.
 */
export function failedNodes(checkpoint: Checkpoint): string[] {
  return Object.entries(checkpoint.graph.nodes)
    .filter(([, node]) => node.status === NodeStatus.FAILED)
    .map(([id]) => id);
}

/**
 * Return node IDs in the current wave that are still gated (status BLOCKED).
 * Relevant during gate_halted state.
 */
export function pendingGates(checkpoint: Checkpoint): string[] {
  const wave = currentWave(checkpoint);
  if (!wave) return [];

  return wave.nodes.filter(
    (nId) => checkpoint.graph.nodes[nId]?.status === NodeStatus.BLOCKED,
  );
}
