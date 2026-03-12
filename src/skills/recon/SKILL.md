---
name: recon
description: Orchestrate reconnaissance missions with optional cross-brain targeting. The Queen scopes the investigation, creates brain tasks, and the lead dispatches Probes and Cortex agents with task IDs.
---

# /recon

Orchestrate a reconnaissance mission: spawn the Queen to scope the investigation, then dispatch Probes and/or Cortex agents with brain task IDs so all findings are linked and retrievable.

Supports cross-brain targeting via `--include` — investigate codebases in other registered brain repositories (auto-initializes unregistered paths).

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

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

### Step 1: Spawn Queen for Scoping

<!-- @claude -->
Spawn the `Queen` agent with the recon question. She will assess what needs to be investigated, decide which agent types are needed (Probe for structural questions, Cortex for deep analysis), create brain tasks for each recon piece, and return a dispatch plan.

Queen prompt template:
```
You are the Queen of Unimatrix Zero. A reconnaissance directive has entered the collective:

"<user question or scope>"

<TARGET BRAINS block if --include was provided>

Scope this investigation. For each question or area that needs exploration, create a brain task (type: task, not epic) with a clear description of what to find or analyze. Assign each task to either `Probe` (structural — find files, trace paths, locate patterns) or `Cortex` (analytical — architecture audit, security review, health assessment). Group into a single epic if multiple tasks are needed. Return a dispatch plan.
```

When `--include` is provided, append to the Queen prompt:
```
TARGET BRAINS:
- <name> (<id>): <root>
- <name> (<id>): <root>

All recon tasks stay in the local brain — do NOT use the `brain` parameter on
`tasks_create`. Note which brain each task targets in the recon dispatch plan
so agents can be dispatched with the correct TARGET CODEBASE path.
```

The Queen returns a **Dispatch Plan** with task IDs and agent assignments.
<!-- @end -->
<!-- @opencode -->
You ARE the planning agent. Scope the investigation directly.

For each question or area that needs exploration, create a brain task (type: task, not epic) with a clear description of what to find or analyze. Assign each task to either `Probe` (structural — find files, trace paths, locate patterns) or `Cortex` (analytical — architecture audit, security review, health assessment). Group into a single epic if multiple tasks are needed.

When `--include` is provided, include the TARGET BRAINS block in your scoping context:
```
TARGET BRAINS:
- <name> (<id>): <root>

All recon tasks stay in the local brain — do NOT use the `brain` parameter on
`tasks_create`. Note which brain each task targets so agents get the correct
TARGET CODEBASE path.
```

Produce a recon dispatch plan with task IDs and agent assignments.
<!-- @end -->

### Step 1b: Enter Plan Mode

<!-- @claude -->
After the Queen returns, call `EnterPlanMode`. Present the recon plan for review. When approved and `ExitPlanMode` fires, the checkpoint hook captures the task state.
<!-- @end -->
<!-- @opencode -->
After the Queen returns, present the recon plan for review. When approved, proceed with dispatch.
<!-- @end -->

### Step 2: Create Team and Generate Designations

<!-- @claude -->
1. Create a team: `TeamCreate` with a descriptive `team_name`
2. Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Probe` for Probe agents, `--role Cortex` for Cortex agents. Generate enough for all agents across all waves.
<!-- @end -->
<!-- @opencode -->
1. Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Probe` for Probe agents, `--role Cortex` for Cortex agents. Generate enough for all agents across all waves.
2. Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

### Step 3: Dispatch Agents

For each task in the Queen's dispatch plan, spawn the assigned agent with the task ID as its prompt.

**Important:** Prefix the agent type in both `name` and `description` — these appear in notifications and help identify which agent produced which output.

**Cross-brain targeting:** When a task targets a non-local brain, prepend this to the agent prompt:
```
TARGET CODEBASE: <root>
All file exploration for this task should be rooted in this directory.
```

<!-- @claude -->
```
Agent:
  subagent_type: "Probe" or "Cortex"
  team_name: "<team name>"
  name: "<agent type>: <short name>"
  description: "<full designation> — <task summary>"
  prompt: |
    <TARGET CODEBASE block if targeting a non-local brain>
    <task ID>
```
The `name` is compact for the status line (e.g. `Probe: Three of Three`). The `description` carries the full designation and task context.
<!-- @end -->
<!-- @opencode -->
```
task(
  subagent_type="probe" or "cortex",
  description="<full designation> — <task summary>",
  run_in_background=true,
  prompt="<TARGET CODEBASE block if targeting a non-local brain>\n<task ID>"
)
```
<!-- @end -->

**Spawning rules:**
- Independent recon tasks: spawn all agents with `run_in_background: true`
- Dependent tasks (e.g., Probe first, then Cortex on same area): spawn sequentially
- If a Probe escalates to Cortex, create a new task and dispatch the Cortex with the Probe's task ID referenced in the description so it can find the Probe's snapshots

### Step 4: Collect Results

- Probes save snapshots linked to their task IDs; Cortex saves both snapshots and artifacts
- When agents complete, their findings are retrievable via `records_list` by `task_id`
- Close tasks as agents report completion

### Step 5: Synthesize (optional)

If multiple agents were dispatched, summarize the combined findings for the user. Reference task IDs and snapshot IDs so the user or downstream agents can drill into specifics.

### Step 6: Cleanup

<!-- @claude -->
1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

## Usage

```
/recon <question, scope, or area to investigate> [--include <ref>,<ref>,...]
```

Each `<ref>` in `--include` can be a brain ID, brain name, or filesystem path (interchangeable). Comma-separated.

## Examples

```
/recon How does the authentication flow work end-to-end?
/recon Audit the security posture of the API layer
/recon How does the checkout flow integrate with the payment gateway? --include app-b2c-api-gateway,app-b2c-spa
/recon Compare the data models across services --include ~/code/api-service,~/code/frontend
```
