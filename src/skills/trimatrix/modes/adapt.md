# Adapt Mode

Alias: adapt

## When Triggered

- Tasks needing iterative refinement with quality gates
- User wants implement-then-review without manual intervention
- Automated correction must run until convergence or max cycles
- User explicitly uses adapt

## Flags

- `--cycles N` — max adaptation cycles (default: 3, max: 5)

---

## Flow

### 1. Initialize

- If brain task ID provided: load via `tasks_get`. Use as directive.
- Otherwise: create brain task with Goal / Files / Instructions / Verification
  sections.
- Record git diff baseline (for final reporting).
- Set `max_cycles` from flag or default.
- Mark task `in_progress`.

### 2. Adaptation Cycle

```
for cycle in 1..max_cycles:

  2a. IMPLEMENT
      Generate designation via Designation Generation Protocol.
      Dispatch drone.
      If cycle > 1: prepend sentinel feedback from prior cycle to adjunct prompt:
        "PRIOR REVIEW FEEDBACK (cycle <N>):\n<feedback verbatim>"
      Wait for completion.

  2b. REVIEW
      Generate designation via Designation Generation Protocol.
      Per Protocol C § C6, classify triviality and select review tier (derive
      locDelta/fileCount/riskKeywords/crossPackage/crossBrain from git output and
      routing signal file; apply cost-cap: teamReviewCount >= 5 → force single Sentinel).
      Dispatch sentinel (TRIVIAL / cost-cap / compatibility fallback) or agent team
      compliance matrix (NON_TRIVIAL, teamReviewCount < 5) with task ID and
      implementation snapshot IDs.
      Wait for verdict in task comments.

  2c. EVALUATE
      Read verdict from sentinel's task comment.
      PASS         → break loop, go to Step 3
      NEEDS_CHANGES → extract issues from comment, store as feedback, continue loop
      BLOCK        → break loop, escalate immediately (Step 3, BLOCK path)
```

### 3. Finalize

**PASS:**

- Report success with cycle count and final commit.
- Close task via `close_node(nodeId)` if this mode created it. Do not close
  externally-provided tasks.

**NEEDS_CHANGES after max_cycles:**

- Report non-convergence. State cycle count reached.
- Output latest Validation issues verbatim.
- Leave task open with `needs_changes` comment. User decides next action.

**BLOCK:**

- Report blocker verbatim from sentinel comment.
- Do not attempt autonomous resolution.
- Leave task in `blocked` state.

---

## Rules

- Never skip the review step. Each cycle requires both drone and sentinel.
- Thread full sentinel feedback into the next drone prompt — no summarization.
- No worktree isolation — adapt mode works in place on the current branch.
- If the task was provided by the caller, do not close it on completion.
- Each cycle generates fresh designations — do not reuse designations across
  cycles.
