---
name: devise
description: Feature planning with interactive scoping — the Queen drives iterative discovery, asking questions and dispatching recon until scope is fully defined, then produces a cross-brain implementation plan.
---

# /devise

<!-- @claude -->
Plan a feature end-to-end with interactive scoping. The Queen drives iterative discovery — asking clarifying questions and dispatching recon agents — until scope is fully defined, then produces an implementation plan with cross-brain task creation.
<!-- @end -->
<!-- @opencode -->
Plan a feature end-to-end with interactive scoping. You drive iterative discovery — asking clarifying questions and dispatching recon agents — until scope is fully defined, then produce an implementation plan with cross-brain task creation.
<!-- @end -->

**This skill only plans — it does NOT execute.** Use `/start-work <epic-id>` or `/assemble` to execute the resulting plan.

## Rules

- **Follow this flow exactly.** Do not insert your own recon or research steps outside the defined loop.
- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.
<!-- @claude -->
- **Save the Queen session ID** from Step 2. Reuse it for ALL subsequent Queen interactions via `resume`.
- The Queen is long-lived — she persists across the entire scoping loop. Her context accumulates with each iteration.
- **The lead relays between the Queen and the user.** The Queen never addresses the user directly. Present her questions without filtering or modifying them.
<!-- @end -->
<!-- @opencode -->
- **You maintain context throughout** — no session management needed.
- **Relay questions to the user.** Present scoping questions without filtering or modifying them.
<!-- @end -->
- **Max scoping iterations: 5.** If scope is not complete after 5 iterations, force `SCOPE_COMPLETE` with the best available information and note gaps in the plan's "Risks & Open Questions" section.

## Flow

### Step 0: Check for --resume

If `--resume` is provided (with an optional artifact ID):

1. If an artifact ID is given, fetch it via `records_fetch_content`. Otherwise, search for the latest `devise-plan` artifact via `records_list` with tag `devise-plan` and fetch the most recent one.
2. Parse the cached plan content (JSON with keys: `feature`, `home_brain`, `target_brains`, `recon_snapshots`, `scoped_at`, `plan`).
3. Present the cached plan to the user with attribution: show the feature description, home brain, scoping timestamp, and target brains.
4. **If `--dry-run` is also set:** present the plan and **stop** — skip all remaining steps. This is a "preview cached plan" mode.
5. Otherwise, ask: "Resume this plan?" If confirmed, **skip to Step 4** (Materialize Plan) with the cached plan content.
<!-- @claude -->
   Spawn a fresh Queen with the cached plan as context:
   ```
   Agent:
     subagent_type: "Queen"
     prompt: |
       You are the Queen of Unimatrix Zero. A previously scoped feature plan is
       being resumed for materialization:

       <cached plan content>

       <TARGET BRAINS block if brains were included>

       Review this plan. If it still looks correct, confirm and proceed to
       materialization when prompted.
   ```
   **Save the returned agent ID** for subsequent steps.
<!-- @end -->
<!-- @opencode -->
   Load the cached plan into your context and proceed to materialization.
<!-- @end -->

### Step 1: Ensure Brains (if --include provided)

If `--include` is provided, resolve all brain refs before proceeding:

1. Run `ensure-brain.py` from the recon skill directory:
   ```bash
   SKILL_DIR="$(dirname "$(readlink -f "$([ -L .claude/skills/recon ] && echo .claude/skills/recon/SKILL.md || echo ~/.claude/skills/recon/SKILL.md)")")" && python3 "$SKILL_DIR/ensure-brain.py" <ref>,<ref>,...
   ```
2. Parse the JSON output lines. Each line contains `{"id": "...", "name": "...", "root": "/abs/path", "initialized": bool}`.
3. If any line contains `"error"`, report the failure to the user and **abort**.
4. Collect the resolved brain info for use in subsequent steps.

### Step 2: Begin Scoping

<!-- @claude -->
Spawn the `Queen` agent with the feature description and resolved brain context.

```
Agent:
  subagent_type: "Queen"
  prompt: |
    You are the Queen of Unimatrix Zero. A feature design directive has entered
    the collective:

    "<feature description>"

    <TARGET BRAINS block if --include was provided>

    You will iteratively scope this feature. Be thorough — if you lack
    information, ask for it. Do not guess at requirements.

    In each iteration, return EXACTLY ONE of these three responses:

    ### QUESTIONS_FOR_USER
    Questions you need the user to answer before proceeding:
    1. <question>
    2. <question>
    ...

    ### RECON_NEEDED
    Reconnaissance needed before proceeding. For each area, specify the agent
    type and which brain to target (if cross-brain):
    1. <question> — Probe | Cortex [— brain: <name>]
    2. <question> — Probe | Cortex [— brain: <name>]
    ...

    ### SCOPE_COMPLETE
    The feature scope is fully defined. Produce the implementation plan using
    the standard Queen plan format (Goal, Context, Steps, Dependencies,
    Dispatch Mode, Risks & Open Questions, Verification).

    Begin scoping. Assess what you know and what you need to learn.
```

When `--include` is provided, append to the prompt:
```
TARGET BRAINS:
- <name> (<id>): <root>

When creating brain tasks for non-local brains, use the `brain` parameter on
`tasks_create` with the brain name. When dispatching recon, note which brain
each question targets so agents explore the correct codebase.
```

**Save the returned agent ID.** This is the Queen's session — reuse it for all subsequent interactions.
<!-- @end -->
<!-- @opencode -->
You ARE the planning agent. Scope the feature directly.

Feature: "<feature description>"

Include the TARGET BRAINS block if `--include` was provided:
```
TARGET BRAINS:
- <name> (<id>): <root>

When creating brain tasks for non-local brains, use the `brain` parameter on
`tasks_create` with the brain name.
```

Iteratively scope this feature. Be thorough — if you lack information, ask
for it. Do not guess at requirements. In each iteration, return EXACTLY ONE of:

### QUESTIONS_FOR_USER
Questions you need answered.

### RECON_NEEDED
Recon areas needed, with agent type and target brain.

### SCOPE_COMPLETE
Feature scope fully defined. Produce the implementation plan.

Begin scoping.
<!-- @end -->

### Step 3: Scoping Loop

Set `iteration = 0`, `max_iterations = 5`.

**Loop:**

#### 3a. Parse the response

Read the planner's response and identify which signal was returned: `QUESTIONS_FOR_USER`, `RECON_NEEDED`, or `SCOPE_COMPLETE`.

#### 3b. Handle QUESTIONS_FOR_USER

Present the questions to the user exactly as provided — do not filter, reword, or add your own questions.

Collect the user's answers, then feed them back:

<!-- @claude -->
```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    User responses to your questions:

    1. <answer>
    2. <answer>
    ...

    Continue scoping. Return QUESTIONS_FOR_USER, RECON_NEEDED, or SCOPE_COMPLETE.
```
<!-- @end -->
<!-- @opencode -->
Feed the answers back into your scoping context and continue:
```
User responses:

1. <answer>
2. <answer>
...

Continue scoping.
```
<!-- @end -->

Increment iteration, continue loop.

#### 3c. Handle RECON_NEEDED

The planner has specified recon questions with agent types and optional brain targets.

1. **Create brain tasks** — For each recon question, create a brain task (type: task) with a clear description. Use the `brain` parameter on `tasks_create` when targeting a non-local brain.
2. **Generate designations** — `/designate <count> --trimatrix` with `--role Probe` for Probes, `--role Cortex` for Cortex agents.
<!-- @claude -->
3. **Create a team** if not already created: `TeamCreate`
4. **Dispatch agents** with brain task IDs:
   ```
   Agent:
     subagent_type: "Probe" or "Cortex"
     team_name: "<team name>"
     name: "<agent type>: <short name>"
     description: "<full designation> — <task summary>"
     prompt: |
       <TARGET CODEBASE: <root> — if targeting a non-local brain>
       <task ID>
     run_in_background: true
   ```
<!-- @end -->
<!-- @opencode -->
3. **Dispatch agents** with brain task IDs:
   ```
   task(
     subagent_type="probe" or "cortex",
     description="<full designation> — <task summary>",
     run_in_background=true,
     prompt="<TARGET CODEBASE: <root> if non-local>\n<task ID>"
   )
   ```
<!-- @end -->
5. **Wait** for all agents to complete.
6. **Collect snapshot IDs** from each agent's completion comment on their brain task.

Feed recon results back:

<!-- @claude -->
```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    Reconnaissance complete. Findings are in these snapshots:
    RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>, ...

    Use `records_fetch_content` to review the findings.
    Continue scoping. Return QUESTIONS_FOR_USER, RECON_NEEDED, or SCOPE_COMPLETE.
```
<!-- @end -->
<!-- @opencode -->
Review the recon findings via `records_fetch_content` on the snapshot IDs. Continue scoping with the new context.
<!-- @end -->

Increment iteration, continue loop.

#### 3d. Handle SCOPE_COMPLETE

The planner has produced the implementation plan. **Break out of the loop.**

#### 3e. Handle max iterations reached

If `iteration >= max_iterations` and scope is not complete:

<!-- @claude -->
```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    Scoping iteration limit reached. Produce the best implementation plan you
    can with current information. Note any gaps or unresolved questions in the
    "Risks & Open Questions" section. Return SCOPE_COMPLETE.
```
<!-- @end -->
<!-- @opencode -->
Force scope completion: produce the best plan with current information. Note gaps in "Risks & Open Questions". Return SCOPE_COMPLETE.
<!-- @end -->

### Step 3f: Cache Plan

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
  "plan": "<the Queen's full SCOPE_COMPLETE plan output>"
}
```

Save via `records_create_artifact`:
- `title`: `"Devise plan [<home brain name>]: <feature summary (first 60 chars)>"`
- `kind`: `"plan"`
- `data`: base64-encoded JSON payload
- `media_type`: `"application/json"`
- `tags`: `["devise-plan", "brain:<home brain name>"]`

Report the artifact ID to the user so they can reference it with `--resume`.

### Step 4: Materialize Plan

**If `--dry-run` was passed, skip this step entirely.** The plan from Step 3 is the final output — present it in Step 6 without creating any brain tasks.

<!-- @claude -->
Resume the Queen to materialize the plan into brain tasks:

```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    Materialize this plan into brain tasks. Follow your standard Phase 2
    materialization process (create epic, create subtasks, set parents,
    set dependencies, save plan artifact).

    For tasks targeting non-local brains, use the `brain` parameter on
    `tasks_create` with the brain name. Use cross-brain refs
    (cross_brain_ref_added) to link related tasks across brains.
```
<!-- @end -->
<!-- @opencode -->
Materialize the plan into brain tasks. Follow your standard materialization process (create epic, create subtasks, set parents, set dependencies, save plan artifact).

For tasks targeting non-local brains, use the `brain` parameter on `tasks_create` with the brain name. Use cross-brain refs to link related tasks across brains.
<!-- @end -->

### Step 5: Cortex Review (default — skip with --skip-review or --dry-run)

Unless `--skip-review` or `--dry-run` was passed:

1. Generate designation: `/designate 1 --role Cortex --trimatrix`
<!-- @claude -->
2. Dispatch Cortex to review the plan:
   ```
   Agent:
     subagent_type: "Cortex"
     name: "Cortex: Plan Review"
     description: "<designation> — review devise plan for <feature>"
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
     description="<designation> — review devise plan",
     run_in_background=true,
     prompt="Review feature plan. Epic: <epic-id>. Use tasks_get with expand children."
   )
   ```
<!-- @end -->
3. Wait for Cortex to complete.
4. Read Cortex findings from the brain task snapshot.
5. If Cortex found **critical** issues:
<!-- @claude -->
   ```
   Agent:
     subagent_type: "Queen"
     resume: "<queen agent ID>"
     prompt: |
       Cortex review found issues with your plan:

       <Cortex findings — critical and warning items>

       Revise the plan to address the critical findings. Update the brain tasks
       accordingly (modify descriptions, add missing tasks, fix dependencies).
   ```
<!-- @end -->
<!-- @opencode -->
   Revise the plan to address critical findings. Update brain tasks accordingly.
<!-- @end -->

### Step 6: Present Plan

<!-- @claude -->
Call `EnterPlanMode`. Present the final feature plan for user review.
<!-- @end -->
<!-- @opencode -->
Present the final feature plan for user review.
<!-- @end -->

Include:
- **Feature summary** — what was scoped and why
- **Requirements** — derived from user answers and recon findings
- **Implementation tasks** — grouped by brain, with task IDs (or proposed tasks if `--dry-run`)
- **Dependency chains** — including cross-brain dependencies
- **Risks & open questions** — anything unresolved
- **Epic task ID** — for use with `/start-work <epic-id>` or `/assemble` (not shown if `--dry-run`)
- **Cached plan artifact ID** — for use with `--resume` in a future session

### Step 7: Cleanup

<!-- @claude -->
1. If a team was created for recon agents, shut it down:
   - `SendMessage` with `type: "shutdown_request"`
   - `TeamDelete`
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

## Usage

```
/devise <feature description> [--include <ref>,<ref>,...] [--skip-review] [--dry-run]
/devise --resume [<artifact-id>]
```

Each `<ref>` in `--include` can be a brain ID, brain name, or filesystem path — used interchangeably. Comma-separated.

`--skip-review` skips the Cortex plan review (Step 5).

`--dry-run` runs the full scoping loop (Steps 1-3) and caches the plan, but skips materialization (Step 4) and Cortex review (Step 5). The Queen's plan is presented as-is without creating any brain tasks. Resume later with `--resume` to materialize.

`--resume [<artifact-id>]` loads a previously cached devise plan and picks up from materialization (Step 4). If no artifact ID is given, loads the most recent `devise-plan` artifact. Combine with `--dry-run` to preview a cached plan without materializing.

## Examples

```
/devise Add WebSocket support for real-time notifications
/devise Implement SSO integration --include app-b2c-api-gateway,app-b2c-spa
/devise Migrate payment flow to new provider --include ~/code/api-service,~/code/checkout --skip-review
/devise Add caching layer --dry-run
/devise --resume
/devise --resume REC-01KKAB3
/devise --resume --dry-run
```
