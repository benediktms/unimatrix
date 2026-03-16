/**
 * State machine for trimatrix execution lifecycle and checkpoint serialization.
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { Checkpoint, Event, Graph, RepoMetadata } from "./types.ts";
import { MachineState } from "./types.ts";
import { computeWaves } from "./graph.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "1.2.0";

/** All checkpoint versions this runtime can load. */
const SUPPORTED_VERSIONS = new Set(["1.0.0", "1.1.0", "1.2.0"]);

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
  opts?: { sessionId?: string; sessionLabel?: string },
): Checkpoint {
  const now = new Date().toISOString();
  return {
    version: VERSION,
    machineState: MachineState.INITIALIZING,
    graph,
    waves: computeWaves(graph),
    currentWaveId: null,
    repos,
    waveHistory: [],
    refinementHistory: [],
    createdAt: now,
    updatedAt: now,
    ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts?.sessionLabel !== undefined
      ? { sessionLabel: opts.sessionLabel }
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
      if (machineState !== MachineState.INITIALIZING) {
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
      if (machineState !== MachineState.DISPATCHING) {
        return {
          allowed: false,
          reason:
            `${event.type} requires dispatching state, got ${machineState}`,
        };
      }
      return { allowed: true };

    case "execution_completed":
      if (machineState !== MachineState.DISPATCHING) {
        return {
          allowed: false,
          reason:
            `execution_completed requires dispatching state, got ${machineState}`,
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
    case "plan_approved":
      return {
        ...checkpoint,
        machineState: MachineState.DISPATCHING,
        updatedAt: now,
      };

    case "wave_dispatched":
      return {
        ...checkpoint,
        currentWaveId: event.waveId,
        updatedAt: now,
      };

    case "node_completed": {
      const node = checkpoint.graph.nodes[event.nodeId];
      if (!node) return { ...checkpoint, updatedAt: now };
      const updatedNode = {
        ...node,
        status: "pr_created" as const,
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
      const updatedNode = {
        ...node,
        status: "failed" as const,
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
        ? {
          ...checkpoint.graph,
          nodes: {
            ...checkpoint.graph.nodes,
            [event.nodeId]: {
              ...node,
              status: "active" as const,
              failureReason: undefined,
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

    case "refine":
      return {
        ...checkpoint,
        machineState: MachineState.REFINING,
        updatedAt: now,
      };

    case "refinement_approved":
      return {
        ...checkpoint,
        machineState: MachineState.DISPATCHING,
        updatedAt: now,
      };

    case "cancel":
      return {
        ...checkpoint,
        machineState: MachineState.CANCELLED,
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

  // Backward compat: sessionId, sessionLabel, cancellationReason, and cancelledAt
  // are optional fields introduced in 1.2.0. Older checkpoints simply omit them —
  // no patching required since all four are typed as optional on Checkpoint.

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
 * Return all node IDs whose status is "failed" across the entire graph.
 */
export function failedNodes(checkpoint: Checkpoint): string[] {
  return Object.entries(checkpoint.graph.nodes)
    .filter(([, node]) => node.status === "failed")
    .map(([id]) => id);
}

/**
 * Return node IDs in the current wave that are still gated (status "blocked").
 * Relevant during gate_halted state.
 */
export function pendingGates(checkpoint: Checkpoint): string[] {
  const wave = currentWave(checkpoint);
  if (!wave) return [];

  return wave.nodes.filter(
    (nId) => checkpoint.graph.nodes[nId]?.status === "blocked",
  );
}
