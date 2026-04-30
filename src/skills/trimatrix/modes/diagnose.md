# Diagnose Mode

Alias: diagnose

## When Triggered

- Bug reports with unclear root cause
- Multiple competing explanations exist
- User explicitly uses diagnose

---

## Flags

- `--fix` — After confirmed diagnosis, dispatch an drone to implement the fix.

---

## Diagnostic Protocol

Include verbatim in every investigator's spawn prompt:

```
DIAGNOSTIC PROTOCOL:
HYPOTHESIS: "<theory>"
OBJECTIVE: Gather evidence that confirms OR disproves your hypothesis. You are an investigator, not an advocate.

INVESTIGATION:
- Trace the symptom through the code
- Run commands to verify behavior
- Collect evidence as file:line citations
- State whether each piece of evidence SUPPORTS or CONTRADICTS the hypothesis

ADVERSARIAL DUTY:
- Read all teammate messages
- If you find counter-evidence for another agent's hypothesis, message them immediately
- Do not wait — disproof is as valuable as proof
- If your own hypothesis is disproven, acknowledge it and redirect effort

WHEN DISPROVEN:
- Acknowledge: "Hypothesis disproven by <evidence>"
- Assist remaining viable hypotheses
- Do not defend a dead theory

COMMUNICATION:
- Share every significant finding via team message immediately
- Respond to all teammate messages
- Save evidence snapshots tagged: diagnosis-evidence, hypothesis:<N>, agent:<designation>

FINAL REPORT:
Save snapshot tagged diagnosis-final with:
- Hypothesis
- Verdict: CONFIRMED / DISPROVEN / INCONCLUSIVE
- Evidence For
- Evidence Against
- Notable interactions with teammates
```

---

## Flow

### Step 1: Generate Hypotheses

Budget: ~20 tool uses. Quick scan around the symptom — error messages, call
sites, recent changes. Generate 3–5 competing hypotheses. Include the user's
stated theory if provided, as one hypothesis. Create brain tasks: one epic + one
subtask per hypothesis (all independent, no chained dependencies).

### Step 1b: Present Hypotheses

Present hypotheses to user before spawning agents. User may approve, add, or
remove entries. Proceed only on explicit approval.

### Step 2: Create Team and Spawn Investigators

1. Use Designation Generation Protocol. Role: DESIGNATE for all investigators.
2. Create team: `TeamCreate(team_name: "diagnosis-<epic-id>")` — **MANDATORY**.
   Abort if creation fails.
3. Spawn one designate per hypothesis into the team.
4. Each agent prompt includes: the Diagnostic Protocol block above, the specific
   `HYPOTHESIS:` line, and the agent's brain task ID.
5. Dispatch all with `run_in_background: true`.

### Step 3: Monitor Investigation

Agents investigate, communicate, and challenge each other autonomously. Queen
does NOT intervene unless an agent is stuck or unresponsive.

Unresponsive agent: sever link, mark task blocked, note which hypotheses remain
active.

### Step 4: Convergence

Collect all snapshots tagged `diagnosis-final` via `records_fetch_content`.
Synthesize:

- Root cause (if confirmed) with evidence chain
- All disproven hypotheses with disproof evidence
- Recommended fix
- Confidence: HIGH (one confirmed, all others disproven) / MEDIUM (probable but
  not fully ruled out) / LOW (inconclusive)

Save diagnosis brief as artifact: `kind: implementation`, tags
`["diagnosis-brief"]`, `task_id: <epic-id>`.

### Step 5: Present Diagnosis

Report root cause, disproven alternatives, recommended fix, and confidence
level. If `--fix` was not passed: stop here. Task Closure Protocol applies.

### Step 6: Fix (if --fix)

If confidence is LOW: ask user before proceeding. Do not auto-fix an
inconclusive diagnosis.

**Simple fix (1–3 files):** Dispatch single drone with diagnosis brief as
context. Run relevant tests after completion.

**Complex fix (4+ files):** Escalate to Adapt Mode. Pass diagnosis brief as the
directive. Do not attempt inline planning.

### Step 7: Cleanup

Shut down all team members. Delete team. Confirm all brain tasks — subtasks and
epic — are in terminal state before reporting completion.
