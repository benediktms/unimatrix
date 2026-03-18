/**
 * Declarative side-effect policy table for the trimatrix state machine.
 *
 * Maps event types to ordered lists of best-effort side effects.
 * Pure data — zero logic. The runner in side-effect-runner.ts executes specs.
 */

import type { Event } from "./types.ts";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum SideEffectAction {
  SYNC_TASK = "SYNC_TASK",
  RECORD_EPISODE = "RECORD_EPISODE",
  SAVE_CHECKPOINT = "SAVE_CHECKPOINT",
}

export enum TaskSyncMode {
  ACTIVATE = "ACTIVATE",
  BLOCK = "BLOCK",
}

export enum SideEffectTier {
  BEST_EFFORT = "BEST_EFFORT",
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SideEffectSpec {
  action: SideEffectAction;
  tier: SideEffectTier;
  /** Only for SYNC_TASK — determines the sync action. */
  mode?: TaskSyncMode;
}

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

/**
 * Maps event types to an ordered list of side-effect specs.
 * Events not in the table produce zero side effects.
 */
export const SIDE_EFFECT_POLICY: Partial<Record<Event["type"], SideEffectSpec[]>> = {
  node_completed: [
    { action: SideEffectAction.SYNC_TASK, mode: TaskSyncMode.ACTIVATE, tier: SideEffectTier.BEST_EFFORT },
    { action: SideEffectAction.RECORD_EPISODE, tier: SideEffectTier.BEST_EFFORT },
  ],
  node_failed: [
    { action: SideEffectAction.SYNC_TASK, mode: TaskSyncMode.BLOCK, tier: SideEffectTier.BEST_EFFORT },
    { action: SideEffectAction.RECORD_EPISODE, tier: SideEffectTier.BEST_EFFORT },
  ],
  wave_dispatched: [
    { action: SideEffectAction.SYNC_TASK, mode: TaskSyncMode.ACTIVATE, tier: SideEffectTier.BEST_EFFORT },
    { action: SideEffectAction.RECORD_EPISODE, tier: SideEffectTier.BEST_EFFORT },
  ],
  wave_completed: [
    { action: SideEffectAction.SAVE_CHECKPOINT, tier: SideEffectTier.BEST_EFFORT },
  ],
  wave_failed: [
    { action: SideEffectAction.SAVE_CHECKPOINT, tier: SideEffectTier.BEST_EFFORT },
  ],
  cancel: [
    { action: SideEffectAction.SAVE_CHECKPOINT, tier: SideEffectTier.BEST_EFFORT },
  ],
  execution_completed: [
    { action: SideEffectAction.SAVE_CHECKPOINT, tier: SideEffectTier.BEST_EFFORT },
  ],
};
