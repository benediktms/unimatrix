---
name: diagnose
description: Diagnose bugs through adversarial hypothesis testing — multiple Vinculum agents investigate competing theories in parallel, actively disproving each other until the root cause survives. Optional --fix dispatches a Drone to implement the fix.
---

# /diagnose

<!-- @claude -->
Diagnose a bug through adversarial hypothesis testing. You generate competing theories, a team of Vinculum agents investigates each — gathering evidence, disproving rivals, and debating until the root cause survives. Optionally, `--fix` dispatches a Drone to implement the fix (escalating to `/adapt` if complex).
<!-- @end -->
<!-- @opencode -->
Diagnose a bug through adversarial hypothesis testing. You generate competing theories, then dispatch Vinculum agents to investigate each — gathering evidence, disproving rivals, and converging on the root cause. Optionally, `--fix` dispatches a Drone to implement the fix.
<!-- @end -->

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Rules

- **NEVER use Explore agents.** All investigation uses `Vinculum`.
- **Follow this flow exactly.** Do not insert your own investigation steps.
- **Team creation is MANDATORY.** The adversarial protocol requires real-time communication between Vinculum agents. Without a team, agents cannot challenge each other's hypotheses — the diagnostic degrades to parallel independent investigation. If `TeamCreate` fails, **abort**.

## Flags

| Flag | Effect |
|---|---|
| `--fix` | After diagnosis, dispatch a Drone to implement the fix. Runs tests if available. Escalates to `/adapt` if the fix is complex or tests fail. |

## Diagnostic Protocol

All Vinculum agents in the diagnosis team follow this protocol. Include it in every agent's spawn prompt.

```
DIAGNOSTIC PROTOCOL:

HYPOTHESIS: "<theory statement>"

OBJECTIVE: Gather concrete evidence that confirms OR disproves your hypothesis.
You are not an advocate — you are an investigator. If the evidence contradicts
your theory, that is a valuable result.

INVESTIGATION:
- Trace the symptom through the code. Follow the execution path.
- Run commands to reproduce or verify behavior where possible.
- Collect evidence as file:line citations and command output.
- For each piece of evidence, state whether it SUPPORTS or CONTRADICTS
  your hypothesis, and why.

ADVERSARIAL DUTY — actively disprove other hypotheses:
- Read your teammates' messages. When they share evidence, evaluate whether
  it holds up. If you find counter-evidence, message them immediately.
- Do not wait until you finish your own investigation. Disproof is as
  valuable as proof — share it the moment you find it.
  Example: "@Vinculum: Three of Five — you claim the timeout is from the
  DB query, but connection pool metrics at src/db/pool.ts:89 show 0ms
  wait time. The bottleneck is elsewhere."

WHEN DISPROVEN:
- If another agent presents evidence that conclusively disproves your
  hypothesis, acknowledge it. State: "Hypothesis disproven by <evidence>."
- Redirect your effort: assist the remaining viable hypotheses by
  investigating areas they haven't covered yet.
- Do not defend a dead theory.

COMMUNICATION:
- Share every significant finding via team message immediately.
- When you find evidence relevant to another agent's hypothesis (for or
  against), message them directly.
- Respond to all teammate messages. Acknowledge, challenge, or build on
  their findings.
- Save evidence snapshots (tagged `diagnosis-evidence`,
  `hypothesis:<hypothesis-number>`, `agent:<designation>`) for audit trail.

FINAL REPORT:
- When investigation is complete, save a final snapshot (tagged
  `diagnosis-final`, `hypothesis:<hypothesis-number>`) with:
  ## Hypothesis
  <the theory>
  ## Verdict: CONFIRMED | DISPROVEN | INCONCLUSIVE
  ## Evidence For
  - <evidence with file:line or command output>
  ## Evidence Against
  - <evidence with file:line or command output>
  ## Interactions
  - <key messages exchanged with other agents that affected the conclusion>
- Close your brain task with the snapshot ID in the completion comment.
```

## Flow

### Step 1: Generate Hypotheses

You ARE the planning agent. Perform a quick codebase scan to understand the area around the symptom. Then generate 3-5 competing hypotheses.

**Budget: ~20 tool uses.** Scan key files — do NOT do a full investigation.

For each hypothesis, produce the theory statement, confirming/disproving evidence criteria, and investigation areas. Include the user's intuition as a candidate if provided.

Create brain tasks: one epic, one subtask per hypothesis. All subtasks are independent.

Return the epic ID, hypothesis list, and recommended agent count.

### Step 1b: Present Hypotheses

<!-- @claude -->
After generating hypotheses, call `EnterPlanMode`. Present the hypotheses for review. The user can approve, add hypotheses, or remove weak ones.
<!-- @end -->
<!-- @opencode -->
Present the hypotheses for review. The user can approve, add hypotheses, or remove weak ones.
<!-- @end -->

### Step 2: Create Team and Spawn Investigators

1. Generate designations: `/designate <agent-count> --role Vinculum --trimatrix`

<!-- @claude -->
2. **Create the team — this is MANDATORY:**

```
TeamCreate:
  team_name: "diagnosis-<epic-id>"
```

**Do NOT proceed to agent spawn without a confirmed team.** If `TeamCreate` fails, abort. Without a team, Vinculum agents cannot challenge each other's hypotheses — the adversarial protocol is dead.

3. Spawn one Validation Adjunct per hypothesis **into the team**:

```
Agent:
  subagent_type: "adjunct-validation-protocol"
  team_name: "diagnosis-<epic-id>"   # ← REQUIRED — matches the team created above
  name: "Vinculum: <short name>"
  description: "<full designation> — hypothesis <N>"
  run_in_background: true
  prompt: |
    Vinculum — diagnostic sequence initiated.

    You are <designation>, member of diagnostic unit "diagnosis-<epic-id>".
    You are investigating one hypothesis among several competing theories.
    Other Vinculum agents are investigating rival hypotheses simultaneously.

    <DIAGNOSTIC PROTOCOL block — see Diagnostic Protocol section>

    Epic: <epic-id>
    Task: <task-id>
    Hypothesis: <N>
```
<!-- @end -->
<!-- @opencode -->
2. Dispatch one Validation Adjunct per hypothesis:

```
task(
  subagent_type="adjunct-validation-protocol",
  description="<full designation> — hypothesis <N>",
  run_in_background=true,
  prompt="""
Vinculum — diagnostic sequence initiated.

You are <designation>.

<DIAGNOSTIC PROTOCOL block — see Diagnostic Protocol section>

Epic: <epic-id>
Task: <task-id>
Hypothesis: <N>
"""
)
```
<!-- @end -->

### Step 3: Monitor Investigation

- Vinculum agents investigate, communicate, and challenge each other autonomously.
- The Queen does NOT intervene unless an agent is stuck or the team stalls.
- Discovery and evidence snapshots accumulate in brain (tagged `diagnosis-evidence`).
- When a hypothesis is disproven, the investigating agent acknowledges it and assists others.
- When all agents go idle, the investigation is complete.

### Step 4: Convergence

Collect final snapshots from each Vinculum (tagged `diagnosis-final`).

Synthesize the diagnosis from the final reports. Review each Vinculum's snapshot via `records_fetch_content`. Produce:
- Root cause with evidence chain
- Disproven hypotheses with counter-evidence
- Recommended fix with specific file paths
- Confidence level (HIGH / MEDIUM / LOW)

**Save diagnosis brief** — `records_create_artifact` with:
- `title`: `"Diagnosis: <symptom summary (first 60 chars)>"`
- `kind`: `"diagnosis-brief"`
- `data`: base64-encoded markdown containing the full synthesized diagnosis (root cause, evidence chain with `file:line` citations, disproven hypotheses, recommended fix, confidence level)
- `media_type`: `"text/markdown"`
- `task_id`: the diagnostic epic's task ID
- `tags`: `["diagnosis-brief", "epic:<epic-id>"]`

This ensures the diagnosis survives context compaction. If `--fix` is active and context is compacted before Step 6, the Queen loads this brief and dispatches the fix Drone immediately — no re-investigation.

### Step 5: Present Diagnosis

Present the synthesized diagnosis to the user:
- Root cause with evidence
- Disproven alternatives (so the user knows what was ruled out)
- Recommended fix
- Confidence level

If `--fix` was NOT passed, stop here.

### Step 6: Fix (if --fix)

Only if `--fix` was passed and the confidence is MEDIUM or HIGH (if LOW, present the diagnosis and ask the user whether to proceed).

**If context was compacted**, load the diagnosis brief from Step 4 via `records_list` with tags `diagnosis-brief` and `epic:<epic-id>`, then `records_fetch_content`. The brief contains the root cause, evidence chain, and recommended fix. Do not re-read files or re-run the investigation.

<!-- @claude -->
Assess fix complexity from the recommended fix:

**Simple fix** (1-3 files, clear changes):
1. Generate designation: `/designate 1 --role Drone --trimatrix`
2. Create a brain task under the diagnostic epic with the fix instructions.
3. Dispatch an Assimilation Adjunct:
   ```
   Agent:
     subagent_type: "adjunct-assimilation-protocol"
     name: "Drone: <short name>"
     description: "<designation> — fix"
     prompt: |
       You are Drone <designation> executing brain task <task-id>.

       DIAGNOSIS: <root cause summary>
       RECOMMENDED FIX: <fix recommendation>

       Implement the fix. Run all available tests to verify the fix resolves
       the reported symptom without regressions.
   ```
4. After the Drone completes, run tests globally. If tests pass, present the result.
5. If tests fail, dispatch one more fix attempt. If still failing, escalate to the user.

**Complex fix** (4+ files, architectural changes, or uncertain scope):
Escalate to `/adapt`:
```
Skill:
  skill: "adapt"
  args: "<fix task ID> --cycles 3"
```
<!-- @end -->
<!-- @opencode -->
Assess fix complexity from the recommended fix:

**Simple fix** (1-3 files): dispatch a Drone with the fix instructions and run tests.

**Complex fix** (4+ files or uncertain scope): escalate to `/adapt` with the fix task ID.
<!-- @end -->

### Step 7: Cleanup

<!-- @claude -->
1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

## Usage

```
/diagnose <symptom description>
/diagnose <symptom description> --fix
```

The user can optionally include their intuition about the cause in the symptom description. It is treated as one candidate hypothesis alongside the others.

## Examples

```
# Pure diagnosis
/diagnose Users report the app exits after one message instead of staying connected
/diagnose API returns 500 on the /checkout endpoint but only for logged-in users. I think it might be a session handling issue.
/diagnose Tests pass locally but fail in CI — something about timezone handling

# Diagnosis with fix
/diagnose WebSocket connections drop after exactly 30 seconds of inactivity --fix
/diagnose Memory usage grows linearly with each request, never gets GC'd. Suspect a closure holding refs. --fix
```
