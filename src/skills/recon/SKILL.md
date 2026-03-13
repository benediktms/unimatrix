---
name: recon
description: Orchestrate reconnaissance missions with optional feature planning. Agents form a recon team, self-claim brain tasks, and share discoveries in real-time. Supports cross-brain targeting (--include) and iterative feature planning (--plan).
---

# /recon

<!-- @claude -->
Orchestrate a reconnaissance mission: you scope the investigation, create brain tasks with a dependency graph, and deploy a recon team. Agents self-claim tasks, share discoveries via team messaging, and persist findings as brain snapshots. Optionally, with `--plan`, you drive iterative feature scoping — asking questions and dispatching recon — then produce an implementation plan.
<!-- @end -->
<!-- @opencode -->
Orchestrate a reconnaissance mission: you scope the investigation, create brain tasks with a dependency graph, and dispatch recon agents. Agents work through tasks and persist findings as brain snapshots. Optionally, with `--plan`, you drive iterative feature scoping — asking questions and dispatching recon — then produce an implementation plan.
<!-- @end -->

Supports cross-brain targeting via `--include` — investigate codebases in other registered brain repositories (auto-initializes unregistered paths).

**With `--plan`, this skill only plans — it does NOT execute.** Use `/reengage <epic-id>` or `/assemble` to execute the resulting plan.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Rules

- **Follow this flow exactly.** Do not insert your own recon or research steps outside the defined steps.
- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.
- **You maintain context throughout** — no session management needed.
- **Relay questions to the user.** Present scoping questions without filtering or modifying them.
- With `--plan`: **Max scoping iterations: 5.** If scope is not complete after 5 iterations, force `SCOPE_COMPLETE` with the best available information and note gaps in the plan's "Risks & Open Questions" section.

## Flags

| Flag | Effect |
|---|---|
| `--include <ref>,<ref>,...` | Cross-brain targeting. Each ref is a brain ID, brain name, or filesystem path. |
| `--plan` | Feature planning mode: iterative scoping → plan → materialize → review. |
| `--dry-run` | With `--plan`: run scoping and cache the plan, but skip materialization and review. |
| `--resume [<artifact-id>]` | With `--plan`: load a cached plan and resume from materialization. |
| `--skip-review` | With `--plan`: skip the Cortex plan review step. |

All flags are orthogonal — any combination is valid.

## Agent Communication Protocol

All agents spawned into the recon team follow this protocol. Include it in every agent's spawn prompt.

```
RECON PROTOCOL:

TASK CLAIMING:
- Read brain tasks under epic <epic-id>. Claim unblocked tasks by marking them
  `in_progress`. Respect dependency ordering — only claim tasks whose
  dependencies are complete.
- Announce every claim via team message: "Claiming <task-id>: <title>".
  This prevents double-claims.

COMMUNICATION — you are part of a team. Communicate actively:
- SHARE DISCOVERIES: When you find something significant, message ALL teammates
  with a concise summary. Do not work in silence — your findings may change
  what another agent investigates or how they interpret their results.
  Example: "Found that AuthService uses JWT stored in httpOnly cookies, not
  session tokens. This affects any investigation into session handling."
- ASK TEAMMATES: If your investigation raises a question about an area another
  agent is exploring, message them directly. Do not duplicate their work —
  ask them to check.
  Example: "@Probe: Three of Five — you're looking at the API layer. Can you
  check whether rate limiting applies to WebSocket connections too?"
- CHALLENGE FINDINGS: If evidence contradicts another agent's finding, message
  them with your counter-evidence. Disagreements are valuable — they surface
  incorrect assumptions. Do not silently accept findings that conflict with
  your observations.
- SYNTHESIZE TOGETHER: When your findings connect with another agent's work,
  message them to build on each other. The team's combined understanding
  should exceed what any individual agent could produce alone.
- RESPOND TO MESSAGES: When a teammate messages you, respond. Acknowledge
  their finding and state how it affects your current task, or answer their
  question. Do not ignore teammate messages.

PERSISTENCE — every significant communication gets a brain snapshot:
- When you share a discovery: save a snapshot (tagged `recon-finding`,
  `team:<team>`, `agent:<designation>`) BEFORE sending the team message.
  Reference the snapshot ID in your message so teammates can fetch full details.
- When you challenge a finding: save a snapshot tagged `recon-challenge`.
- When you complete a task: save a final comprehensive snapshot (tagged
  `recon-final`, `task:<task-id>`) summarizing all findings for that task.
  Close the brain task with the snapshot ID in the completion comment.

LIFECYCLE:
- After completing a task, claim the next available unblocked task.
- If no tasks remain, go idle. Do not invent work.
```

## Flow

### Step 0: Resolve Brain Targets (if --include provided)

If `--include` is provided, resolve all brain refs before proceeding:

1. Run `ensure-brain.py` with the comma-separated refs:
   ```bash
   SKILL_DIR="$(dirname "$(readlink -f "$([ -L .claude/skills/recon ] && echo .claude/skills/recon/SKILL.md || echo ~/.claude/skills/recon/SKILL.md)")")" && python3 "$SKILL_DIR/ensure-brain.py" <ref>,<ref>,...
   ```
2. Parse the JSON output lines. Each line contains `{"id": "...", "name": "...", "root": "/abs/path", "initialized": bool}`.
3. If any line contains `"error"`, report the failure to the user and **abort**.
4. Collect the resolved brain info for use in subsequent steps.

### Step 0b: Resume Cached Plan (if --plan --resume)

Only if `--plan` and `--resume` are both provided:

1. If an artifact ID is given, fetch it via `records_fetch_content`. Otherwise, search for the latest `recon-plan` artifact via `records_list` with tag `recon-plan` and fetch the most recent one.
2. Parse the cached plan content (JSON with keys: `feature`, `home_brain`, `target_brains`, `recon_snapshots`, `scoped_at`, `plan`).
3. Present the cached plan to the user with attribution: show the feature description, home brain, scoping timestamp, and target brains.
4. **If `--dry-run` is also set:** present the plan and **stop** — skip all remaining steps. This is a "preview cached plan" mode.
5. Otherwise, ask: "Resume this plan?" If confirmed, **skip to Step 6** (Materialize Plan) with the cached plan content.
<!-- @claude -->
   Load the cached plan into your context and proceed to materialization.
<!-- @end -->
<!-- @opencode -->
   Load the cached plan into your context and proceed to materialization.
<!-- @end -->

### Step 1: Scoping

You ARE the planning agent. Scope directly.

**Without `--plan`** — single-pass investigation scoping:

Break the investigation into granular, self-contained brain tasks — each with a clear question, specific areas to examine, and concrete deliverables. Aim for 5-6 tasks per agent. Recommend the agent count based on task count. Assign to `Probe` or `Cortex`. Group under an epic. Set dependencies where ordering matters. Produce a dispatch plan with the epic ID, task dependency graph, and recommended agent count.

**With `--plan`** — iterative feature scoping:

Iteratively scope the feature. In each iteration, return EXACTLY ONE of: `QUESTIONS_FOR_USER`, `RECON_NEEDED`, or `SCOPE_COMPLETE`. See the flag descriptions above for signal formats.

When `--include` is provided, include the TARGET BRAINS block:
```
TARGET BRAINS:
- <name> (<id>): <root>

All recon tasks stay in the local brain — do NOT use the `brain` parameter on
`tasks_create`. Note which brain each task targets so agents get the correct
TARGET CODEBASE path.
```

---

## Investigation Flow (without --plan)

### Step 2: Plan Approval

<!-- @claude -->
After scoping, call `EnterPlanMode`. Present the recon plan for review. When approved and `ExitPlanMode` fires, the checkpoint hook captures the task state.
<!-- @end -->
<!-- @opencode -->
After scoping, present the recon plan for review. When approved, proceed with dispatch.
<!-- @end -->

### Step 3: Create Team and Spawn Agents

1. Use the recommended agent count. Generate designations: `/designate <agent-count> --trimatrix` — use `--role Probe` for Probes, `--role Cortex` for Cortex agents.
<!-- @claude -->
2. Create a team: `TeamCreate` with a descriptive `team_name`
3. Spawn all agents into the team. Agents receive the epic ID and self-claim tasks — do NOT assign specific tasks to specific agents. The task descriptions are detailed enough for agents to work autonomously.

**Cross-brain targeting:** When a task targets a non-local brain, include `TARGET CODEBASE: <root>` in the agent prompt. Agents exploring non-local brains should root all file operations in that directory.

```
Agent:
  subagent_type: "Probe" or "Cortex"
  team_name: "<team name>"
  name: "<agent type>: <short name>"
  description: "<full designation> — recon agent"
  run_in_background: true
  prompt: |
    You are <agent type> <designation>, member of recon unit "<team name>".

    <RECON PROTOCOL block — see Agent Communication Protocol section>

    <TARGET CODEBASE: <root> — if any tasks target a non-local brain>

    Epic: <epic-id>
```
The `name` is compact for the status line (e.g. `Probe: Three of Three`). The `description` carries the full designation and context.
<!-- @end -->
<!-- @opencode -->
2. Dispatch all agents. Agents receive the epic ID and self-claim tasks.

**Cross-brain targeting:** When a task targets a non-local brain, include `TARGET CODEBASE: <root>` in the agent prompt.

```
task(
  subagent_type="probe" or "cortex",
  description="<full designation> — recon agent",
  run_in_background=true,
  prompt="""
You are <agent type> <designation>.

<RECON PROTOCOL block — see Agent Communication Protocol section>

<TARGET CODEBASE: <root> — if any tasks target a non-local brain>

Epic: <epic-id>
"""
)
```
<!-- @end -->

### Step 4: Monitor and Collect

- Agents self-claim brain tasks, work through the dependency graph, and go idle when no tasks remain.
- Discovery snapshots accumulate in brain throughout the investigation (tagged `recon-finding`).
- Final snapshots are saved per-task on completion (tagged `recon-final`).
- When all agents are idle, collect the final snapshot IDs from brain task completion comments.

### Step 5: Synthesize

Summarize the combined findings for the user. Reference task IDs and snapshot IDs so the user or downstream agents can drill into specifics.

If agents recorded challenges or contradictions (tagged `recon-challenge`), highlight unresolved disagreements.

### Step 6: Cleanup

<!-- @claude -->
1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

---

## Feature Planning Flow (with --plan)

### Step 2: Scoping Loop

Set `iteration = 0`, `max_iterations = 5`.

**Loop:**

#### 2a. Parse the response

Read the planner's response and identify which signal was returned: `QUESTIONS_FOR_USER`, `RECON_NEEDED`, or `SCOPE_COMPLETE`.

#### 2b. Handle QUESTIONS_FOR_USER

Present the questions to the user exactly as provided — do not filter, reword, or add your own questions.

Collect the user's answers, then feed them back into your scoping context and continue:
```
User responses:

1. <answer>
2. <answer>
...

Continue scoping.
```

Increment iteration, continue loop.

#### 2c. Handle RECON_NEEDED

The planner has specified recon questions with agent types and optional brain targets, and created brain tasks under an epic with a dependency graph.

1. **Generate designations** — `/designate <count> --trimatrix` with `--role Probe` for Probes, `--role Cortex` for Cortex agents.
<!-- @claude -->
2. **Create a team** if not already created: `TeamCreate`
3. **Spawn agents** into the team with the epic ID. Same dispatch format as Investigation Flow Step 3 — agents self-claim brain tasks.
<!-- @end -->
<!-- @opencode -->
2. **Dispatch agents** with the epic ID. Same dispatch format as Investigation Flow Step 3.
<!-- @end -->
4. **Wait** for all agents to complete.
5. **Collect snapshot IDs** from each agent's completion comment on their brain task.

Review the recon findings via `records_fetch_content` on the snapshot IDs. Continue scoping with the new context.

Increment iteration, continue loop.

#### 2d. Handle SCOPE_COMPLETE

The implementation plan is produced. **Break out of the loop.**

#### 2e. Handle max iterations reached

If `iteration >= max_iterations` and scope is not complete:

Force scope completion: produce the best plan with current information. Note gaps in "Risks & Open Questions". Return SCOPE_COMPLETE.

### Step 3: Cache Plan

After SCOPE_COMPLETE, **always** save the plan as a brain artifact — regardless of `--dry-run` or normal mode. This enables resumption from a future session.

Determine the current brain identity by running:
```bash
brain id
```

Build a JSON payload with:
```json
{
  "feature": "<original feature description>",
  "home_brain": {"id": "<current brain ID>", "name": "<current brain name>"},
  "target_brains": [{"id": "...", "name": "...", "root": "..."}],
  "recon_snapshots": ["<snapshot-id-1>", "<snapshot-id-2>"],
  "scoped_at": "<ISO 8601 timestamp>",
  "plan": "<the full SCOPE_COMPLETE plan output>"
}
```

Save via `records_create_artifact`:
- `title`: `"Recon plan [<home brain name>]: <feature summary (first 60 chars)>"`
- `kind`: `"plan"`
- `data`: base64-encoded JSON payload
- `media_type`: `"application/json"`
- `tags`: `["recon-plan", "brain:<home brain name>"]`

Report the artifact ID to the user so they can reference it with `--resume`.

### Step 4: Present Plan (if --dry-run)

**If `--dry-run` was passed, present the plan and stop.** Skip materialization and review. The cached artifact is the deliverable — report its ID for later `--resume`.

### Step 5: Materialize Plan

Materialize the plan into brain tasks. Follow your standard materialization process (create epic, create subtasks, set parents, set dependencies, save plan artifact).

For tasks targeting non-local brains, use the `brain` parameter on `tasks_create` with the brain name. Use cross-brain refs to link related tasks across brains.

### Step 6: Cortex Review (skip with --skip-review)

Unless `--skip-review` was passed:

1. Generate designation: `/designate 1 --role Cortex --trimatrix`
<!-- @claude -->
2. Dispatch Cortex as a standalone agent (NOT part of the recon team — this is plan review, not codebase investigation):
   ```
   Agent:
     subagent_type: "Cortex"
     name: "Cortex: Plan Review"
     description: "<designation> — review recon plan for <feature>"
     prompt: |
       Cortical node activated. Review this feature implementation plan for
       completeness, feasibility, and risk.

       Epic task ID: <epic-id>

       Use `tasks_get` with expand: ["children"] to load the full plan structure.

       Assess:
       - Are tasks well-scoped and independently executable?
       - Are dependencies correct and complete?
       - Are there missing steps, integration gaps, or unaddressed risks?
       - For cross-brain tasks: are brain assignments correct?

       Focus on plan quality — the code does not exist yet.
       Produce your standard analysis report with severity-ranked findings.
   ```
<!-- @end -->
<!-- @opencode -->
2. Dispatch Cortex:
   ```
   task(
     subagent_type="cortex",
     description="<designation> — review recon plan",
     run_in_background=true,
     prompt="Review feature plan. Epic: <epic-id>. Use tasks_get with expand children."
   )
   ```
<!-- @end -->
3. Wait for Cortex to complete.
4. Read Cortex findings from the brain task snapshot.
5. If Cortex found **critical** issues:
   Revise the plan to address critical findings. Update brain tasks accordingly.

### Step 7: Present Plan

<!-- @claude -->
Call `EnterPlanMode`. Present the final feature plan for user review.
<!-- @end -->
<!-- @opencode -->
Present the final feature plan for user review.
<!-- @end -->

Include:
- **Feature summary** — what was scoped and why
- **Requirements** — derived from user answers and recon findings
- **Implementation tasks** — grouped by brain, with task IDs
- **Dependency chains** — including cross-brain dependencies
- **Risks & open questions** — anything unresolved
- **Epic task ID** — for use with `/reengage <epic-id>` or `/assemble`
- **Cached plan artifact ID** — for use with `--resume` in a future session

### Step 8: Cleanup

<!-- @claude -->
1. If a recon team was created, shut it down:
   - `SendMessage` with `type: "shutdown_request"`
   - `TeamDelete`
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

## Usage

```
/recon <question, scope, or area to investigate> [--include <ref>,<ref>,...]
/recon --plan <feature description> [--include <ref>,<ref>,...] [--skip-review] [--dry-run]
/recon --plan --resume [<artifact-id>]
/recon --plan --resume [<artifact-id>] --dry-run
```

Each `<ref>` in `--include` can be a brain ID, brain name, or filesystem path (interchangeable). Comma-separated.

## Examples

```
# Pure investigation — local
/recon How does the authentication flow work end-to-end?
/recon Audit the security posture of the API layer

# Pure investigation — cross-brain
/recon How does the checkout flow integrate with the payment gateway? --include app-b2c-api-gateway,app-b2c-spa
/recon Compare the data models across services --include ~/code/api-service,~/code/frontend

# Feature planning — local
/recon --plan Add WebSocket support for real-time notifications
/recon --plan Add caching layer --dry-run

# Feature planning — cross-brain
/recon --plan Implement SSO integration --include app-b2c-api-gateway,app-b2c-spa
/recon --plan Migrate payment flow to new provider --include ~/code/api-service,~/code/checkout --skip-review

# Resume a cached plan
/recon --plan --resume
/recon --plan --resume REC-01KKAB3
/recon --plan --resume --dry-run
```
