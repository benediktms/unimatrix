/**
 * Side-effect runner for the trimatrix state machine.
 *
 * Wraps pure `transition()` calls with declarative side effects from the
 * policy table. Effects return checkpoint patches instead of mutating state
 * through callbacks.
 */

import type { BrainExec } from "./brain-sync.ts";
import {
  repoRoot as repoRootLookup,
  syncTaskStatus,
  writeEpisode,
} from "./brain-sync.ts";
import {
  SIDE_EFFECT_POLICY,
  SideEffectAction,
  TaskSyncMode,
} from "./side-effect-policy.ts";
import type { SideEffectSpec } from "./side-effect-policy.ts";
import { appendEvent } from "./state.ts";
import type { Checkpoint, Event } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EffectContext {
  before: Checkpoint;
  after: Checkpoint;
  event: Event;
}

interface EffectDeps {
  brainExec: BrainExec;
}

export interface TransitionResult {
  checkpoint: Checkpoint;
  shouldSaveCheckpoint: boolean;
}

interface ExecutorResult {
  checkpointPatch?: Partial<Checkpoint>;
}

// ---------------------------------------------------------------------------
// Effect executors
// ---------------------------------------------------------------------------

type EffectExecutor = (
  spec: SideEffectSpec,
  ctx: EffectContext,
  deps: EffectDeps,
) => Promise<ExecutorResult>;

async function executeSyncTask(
  spec: SideEffectSpec,
  ctx: EffectContext,
  deps: EffectDeps,
): Promise<ExecutorResult> {
  const event = ctx.event;
  const mode = spec.mode === TaskSyncMode.BLOCK ? "block" : "activate";

  if (event.type === "node_completed" || event.type === "node_failed") {
    const nodeId = event.nodeId;
    const node = ctx.after.graph.nodes[nodeId];
    if (node?.taskId) {
      const cwd = repoRootLookup(ctx.after.repos, node.repo);
      await syncTaskStatus(node.taskId, mode, cwd, deps.brainExec);
    }
  } else if (event.type === "wave_dispatched") {
    const wave = ctx.after.waves.find((w) => w.id === event.waveId);
    if (wave) {
      const promises = wave.nodes
        .map((nid) => ctx.after.graph.nodes[nid])
        .filter((n) => n?.taskId)
        .map((n) => {
          const cwd = repoRootLookup(ctx.after.repos, n.repo);
          return syncTaskStatus(n.taskId!, mode, cwd, deps.brainExec);
        });
      await Promise.all(promises);
    }
  }

  return {};
}

async function executeRecordEpisode(
  _spec: SideEffectSpec,
  ctx: EffectContext,
  deps: EffectDeps,
): Promise<ExecutorResult> {
  const event = ctx.event;
  let goal: string;
  let actions: string[];
  let outcome: string;
  let tags: string[];
  let importance: number | undefined;

  const sessionTag = `session:${ctx.after.sessionId ?? "unknown"}`;

  if (event.type === "node_completed") {
    const node = ctx.after.graph.nodes[event.nodeId];
    const prInfo = node?.prUrl ? `PR: ${node.prUrl}` : "direct completion";
    goal = `Node "${node?.label ?? event.nodeId}" completed`;
    actions = [prInfo];
    outcome = String(node?.status ?? "DONE");
    tags = ["trimatrix", "node-complete", sessionTag];
  } else if (event.type === "node_failed") {
    const node = ctx.after.graph.nodes[event.nodeId];
    goal = `Node "${node?.label ?? event.nodeId}" failed`;
    actions = [event.reason];
    outcome = "failed";
    tags = ["trimatrix", "failure", sessionTag];
    importance = 0.9;
  } else if (event.type === "wave_dispatched") {
    const wave = ctx.after.waves.find((w) => w.id === event.waveId);
    const nodeLabels = (wave?.nodes ?? [])
      .map((nid) => ctx.after.graph.nodes[nid]?.label)
      .filter(Boolean) as string[];
    goal = `Wave ${event.waveId} dispatched for session "${ctx.after.sessionLabel ?? ctx.after.sessionId}"`;
    actions = nodeLabels;
    outcome = "dispatching";
    tags = ["trimatrix", "wave", sessionTag];
  } else {
    return {};
  }

  const summaryId = await writeEpisode(
    goal,
    actions,
    outcome,
    tags,
    importance,
    undefined,
    deps.brainExec,
  );

  if (summaryId) {
    return {
      checkpointPatch: {
        episodeIds: [...(ctx.after.episodeIds ?? []), summaryId],
      },
    };
  }

  return {};
}

function executeSaveCheckpoint(
  _spec: SideEffectSpec,
  _ctx: EffectContext,
  _deps: EffectDeps,
): Promise<ExecutorResult> {
  // No-op — the shouldSaveCheckpoint flag signals server.ts to persist.
  return Promise.resolve({});
}

const EXECUTORS: Record<SideEffectAction, EffectExecutor> = {
  [SideEffectAction.SYNC_TASK]: executeSyncTask,
  [SideEffectAction.RECORD_EPISODE]: executeRecordEpisode,
  [SideEffectAction.SAVE_CHECKPOINT]: executeSaveCheckpoint,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `transitionWithEffects` function wired to the given dependencies.
 *
 * 1. Calls pure `transition(checkpoint, event)` — throws on illegal transition.
 * 2. Looks up `SIDE_EFFECT_POLICY[event.type]` — absent = no-op.
 * 3. Executes specs sequentially, collecting checkpoint patches.
 * 4. Merges patches into the post-transition checkpoint.
 * 5. Returns `{ checkpoint, shouldSaveCheckpoint }`.
 */
export function createEffectRunner(
  deps: EffectDeps,
): (checkpoint: Checkpoint, event: Event) => Promise<TransitionResult> {
  return async function transitionWithEffects(
    checkpoint: Checkpoint,
    event: Event,
  ): Promise<TransitionResult> {
    // Use `appendEvent` instead of bare `transition` so every server-side
    // mutation lands in the event log. This is the wiring contract for
    // UNM-1b7.3 — without it, replay-on-crash is theoretical because the
    // log never gets written. `appendEvent` itself calls `transition`
    // internally; the seq + log-entry plumbing happens inside.
    const after = appendEvent(checkpoint, event);

    const specs = SIDE_EFFECT_POLICY[event.type];
    if (!specs || specs.length === 0) {
      return { checkpoint: after, shouldSaveCheckpoint: false };
    }

    const ctx: EffectContext = { before: checkpoint, after, event };
    let merged = after;
    let shouldSaveCheckpoint = false;

    for (const spec of specs) {
      if (spec.action === SideEffectAction.SAVE_CHECKPOINT) {
        shouldSaveCheckpoint = true;
      }

      try {
        const executor = EXECUTORS[spec.action];
        // Each executor sees the progressively merged checkpoint via `after: merged`.
        // Patches are shallow-merged — array fields (e.g. episodeIds) are REPLACED,
        // not concatenated. Executors returning array patches MUST read from ctx.after
        // and append, never construct independently. See: trimatrix_checkpoint_concurrency.md
        const result = await executor(spec, { ...ctx, after: merged }, deps);
        if (result.checkpointPatch) {
          merged = { ...merged, ...result.checkpointPatch };
        }
      } catch (err) {
        console.error("[trimatrix effect]", err);
      }
    }

    return { checkpoint: merged, shouldSaveCheckpoint };
  };
}
