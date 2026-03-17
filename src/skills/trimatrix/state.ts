/**
 * State machine for trimatrix execution lifecycle and checkpoint serialization.
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { Checkpoint, Event, Graph, Intent, Node, RepoMetadata, SubgraphStrategy, Tier } from "./types.ts";
import { Executor, NodeStatus } from "./types.ts";
import { computeWaves } from "./graph.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "2.1.0";

/** All checkpoint versions this runtime can load. */
const SUPPORTED_VERSIONS = new Set(["1.0.0", "1.1.0", "1.2.0", "1.3.0", "2.0.0", "2.1.0"]);

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
  },
): Checkpoint {
  const now = new Date().toISOString();
  return {
    version: VERSION,
    machineState: "initializing",
    graph,
    waves: computeWaves(graph),
    currentWaveId: null,
    repos,
    waveHistory: [],
    refinementHistory: [],
    createdAt: now,
    updatedAt: now,
    subgraphs: [],
    ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts?.sessionLabel !== undefined
      ? { sessionLabel: opts.sessionLabel }
      : {}),
    ...(opts?.intent !== undefined ? { intent: opts.intent } : {}),
    ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts?.subgraphStrategy !== undefined
      ? { subgraphStrategy: opts.subgraphStrategy }
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
    case "plan_approved":
      if (machineState !== "initializing") {
        return {
          allowed: false,
          reason:
            `plan_approved requires initializing state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "wave_dispatched":
    case "node_completed":
    case "node_failed":
    case "wave_completed":
    case "wave_failed":
      if (machineState !== "dispatching") {
        return {
          allowed: false,
          reason:
            `${event.type} requires dispatching state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "execution_completed":
      if (machineState !== "dispatching") {
        return {
          allowed: false,
          reason:
            `execution_completed requires dispatching state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "gate_cleared":
      if (machineState !== "gate_halted") {
        return {
          allowed: false,
          reason:
            `gate_cleared requires gate_halted state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "retry_wave":
      if (machineState !== "failed") {
        return {
          allowed: false,
          reason: `retry_wave requires failed state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "refine":
      if (
        machineState !== "dispatching" &&
        machineState !== "gate_halted" &&
        machineState !== "failed"
      ) {
        return {
          allowed: false,
          reason:
            `refine requires dispatching, gate_halted, or failed state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "refinement_approved":
      if (machineState !== "refining") {
        return {
          allowed: false,
          reason:
            `refinement_approved requires refining state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "cancel":
      if (machineState === "completed" || machineState === "cancelled") {
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
    case "plan_approved":
      return {
        ...checkpoint,
        machineState: "dispatching",
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
        status: event.prUrl ? NodeStatus.PR_CREATED : (node.repo ? NodeStatus.MERGED : NodeStatus.DONE),
        ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
        ...(event.prNumber !== undefined ? { prNumber: event.prNumber } : {}),
      };
      return {
        ...checkpoint,
        graph: {
          ...checkpoint.graph,
          nodes: {
            ...checkpoint.graph.nodes,
            [event.nodeId]: updatedNode,
          },
        },
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
      return {
        ...checkpoint,
        graph: {
          ...checkpoint.graph,
          nodes: {
            ...checkpoint.graph.nodes,
            [event.nodeId]: updatedNode,
          },
        },
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
          machineState: "gate_halted",
          updatedAt: now,
        };
      }

      if (isLastWave) {
        return {
          ...checkpoint,
          machineState: "completed",
          updatedAt: now,
        };
      }

      return { ...checkpoint, updatedAt: now };
    }

    case "wave_failed":
      return {
        ...checkpoint,
        machineState: "failed",
        updatedAt: now,
      };

    case "execution_completed":
      return {
        ...checkpoint,
        machineState: "completed",
        updatedAt: now,
      };

    case "gate_cleared": {
      // Mark the node as active to clear its blocked state
      const node = checkpoint.graph.nodes[event.nodeId];
      const updatedGraph = node
        ? {
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
        }
        : checkpoint.graph;

      // Check whether all pending gates in the current wave are cleared
      const allGatesCleared = pendingGates({
        ...checkpoint,
        graph: updatedGraph,
      }).length === 0;

      return {
        ...checkpoint,
        graph: updatedGraph,
        machineState: allGatesCleared ? "dispatching" : "gate_halted",
        updatedAt: now,
      };
    }

    case "retry_wave":
      return {
        ...checkpoint,
        machineState: "dispatching",
        currentWaveId: event.waveId,
        updatedAt: now,
      };

    case "refine":
      return {
        ...checkpoint,
        machineState: "refining",
        updatedAt: now,
      };

    case "refinement_approved":
      return {
        ...checkpoint,
        machineState: "dispatching",
        updatedAt: now,
      };

    case "cancel":
      return {
        ...checkpoint,
        machineState: "cancelled",
        cancellationReason: event.reason,
        cancelledAt: now,
        updatedAt: now,
      };
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

  return cp;
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
