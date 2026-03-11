---
name: adapt
description: Iterative refinement loop — dispatches a drone to implement, vinculum to review, and cycles until the vinculum passes or max cycles are reached.
---

# /adapt

Autonomous adaptation cycle: implement → review → refine → repeat. The Borg's defining trait, encoded as a feedback loop.

## When to use

- A task needs iterative refinement to reach quality gates
- You want a drone's output validated and auto-corrected without manual intervention
- The queen wants to fire-and-forget a subtask that self-heals on review feedback

## Behavior

When invoked, you (the lead agent) orchestrate the following loop:

### 1. Initialize

- If a brain task ID is provided, use it. Read the task with `tasks_get`.
- If no task ID is provided, create a brain task via `tasks_apply_event` (task_created) with the user's goal as the description. Include a `## Goal`, `## Files`, `## Instructions`, and `## Verification` section.
- Record the starting diff baseline: `git diff --stat` (so the vinculum can isolate this cycle's changes).
- Set `max_cycles` from the `--cycles` argument (default: 3, hard max: 5).

### 2. Adaptation Cycle

```
for cycle in 1..max_cycles:

  2a. IMPLEMENT — Dispatch a `drone` agent with the task ID.
      - Generate a designation: `/designate 1 --role drone`
      - If cycle > 1, prepend the vinculum's feedback to the drone prompt:
        "Previous review found these issues — address them:\n<vinculum issues>"
      - Wait for the drone to complete.

  2b. REVIEW — Dispatch a `vinculum` agent with the task ID.
      - Generate a designation: `/designate 1 --role vinculum`
      - Wait for the vinculum to complete.

  2c. EVALUATE — Read the vinculum's verdict from the task comments.
      - PASS → break the loop, proceed to step 3.
      - NEEDS_CHANGES → extract the issues list, continue to next cycle.
      - BLOCK → break the loop, escalate to user immediately.
```

### 3. Finalize

- **On PASS**: Report success to the user. Close the task via `tasks_close` if it was created by this skill.
- **On NEEDS_CHANGES after max cycles**: Report that adaptation did not converge. Show the vinculum's latest issues. Let the user decide whether to extend cycles or intervene manually.
- **On BLOCK**: Report the blockers verbatim. Do not attempt further cycles.

## Arguments

```
/adapt <task-id or goal description>           # 3 cycles (default)
/adapt --cycles 5 <task-id or goal>            # Up to 5 cycles
/adapt --cycles 1 <task-id or goal>            # Single pass (drone + review, no retry)
```

## Example

```
/adapt --cycles 2 "Add input validation to the /api/users endpoint"
```

Cycle 1: Drone adds validation. Vinculum finds missing edge case for empty strings.
Cycle 2: Drone fixes edge case. Vinculum passes.
Done in 2 adaptation cycles.

## Rules

- Never skip the vinculum step. Every drone output gets reviewed.
- Thread the full vinculum feedback into the next drone — don't summarize or filter issues.
- If the vinculum gives PASS on cycle 1, that's ideal — don't add unnecessary cycles.
- Do not use worktree isolation. The drone works in the main tree so the vinculum can diff against the baseline.
- If the task was provided (not created by this skill), do not close it — the caller manages lifecycle.
