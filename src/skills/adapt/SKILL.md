---
name: adapt
description: Iterative refinement loop — dispatches an Assimilation adjunct to implement, Validation adjunct to review, and cycles until the Validation adjunct passes or max cycles are reached.
---

# /adapt

Autonomous adaptation cycle: implement → review → refine → repeat. The Borg's defining trait, encoded as a feedback loop.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## When to use

- A task needs iterative refinement to reach quality gates
- You want an Assimilation adjunct's output validated and auto-corrected without manual intervention
- The Queen wants to fire-and-forget a subtask that self-heals on review feedback

## Behavior

When invoked, you (the Queen agent) orchestrate the following loop:

### 1. Initialize

- If a brain task ID is provided, use it. Read the task with `tasks_get`.
- If no task ID is provided, create a brain task via `tasks_apply_event` (task_created) with the user's goal as the description. Include a `## Goal`, `## Files`, `## Instructions`, and `## Verification` section.
- Record the starting diff baseline: `git diff --stat` (so the Validation adjunct can isolate this cycle's changes).
- Set `max_cycles` from the `--cycles` argument (default: 3, hard max: 5).

### 2. Adaptation Cycle

<!-- @claude -->
Dispatches use Claude Code `Agent(...)` with `subagent_type: "adjunct-assimilation-protocol"` and `subagent_type: "adjunct-validation-protocol"`.
<!-- @end -->
<!-- @opencode -->
Dispatches use OpenCode `task(...)` with `subagent_type="adjunct-assimilation-protocol"` and `subagent_type="adjunct-validation-protocol"`.
<!-- @end -->

```
for cycle in 1..max_cycles:

  2a. IMPLEMENT — Dispatch an `Assimilation`/`assimilation` adjunct with the task ID.
      - Generate a designation: `/designate 1 --role Assimilation --trimatrix`
      - If cycle > 1, prepend the Validation adjunct's feedback to the Assimilation adjunct prompt:
        "Previous review found these issues — address them:\n<Validation issues>"
      - Wait for the Assimilation adjunct to complete.

  2b. REVIEW — Dispatch a `Validation`/`validation` adjunct with the task ID.
      - Generate a designation: `/designate 1 --role Validation --trimatrix`
      - Wait for the Validation adjunct to complete.

  2c. EVALUATE — Read the Validation adjunct's verdict from the task comments.
      - PASS → break the loop, proceed to step 3.
      - NEEDS_CHANGES → extract the issues list, continue to next cycle.
      - BLOCK → break the loop, escalate to user immediately.
```

### 3. Finalize

- **On PASS**: Report success to the user. Close the task via `tasks_close` if it was created by this skill.
- **On NEEDS_CHANGES after max cycles**: Report that adaptation did not converge. Show the Validation adjunct's latest issues. Let the user decide whether to extend cycles or intervene manually.
- **On BLOCK**: Report the blockers verbatim. Do not attempt further cycles.

## Arguments

```
/adapt <task-id or goal description>           # 3 cycles (default)
/adapt --cycles 5 <task-id or goal>            # Up to 5 cycles
/adapt --cycles 1 <task-id or goal>            # Single pass (Assimilation adjunct + review, no retry)
```

## Example

```
/adapt --cycles 2 "Add input validation to the /api/users endpoint"
```

Cycle 1: Assimilation adjunct adds validation. Validation adjunct finds missing edge case for empty strings.
Cycle 2: Assimilation adjunct fixes edge case. Validation adjunct passes.
Done in 2 adaptation cycles.

## Rules

- Never skip the Validation adjunct step. Every Assimilation adjunct output gets reviewed.
- Thread the full Validation adjunct feedback into the next Assimilation adjunct — don't summarize or filter issues.
- If the Validation adjunct gives PASS on cycle 1, that's ideal — don't add unnecessary cycles.
- Do not use worktree isolation. The Assimilation adjunct works in the main tree so the Validation adjunct can diff against the baseline.
- If the task was provided (not created by this skill), do not close it — the caller manages lifecycle.
