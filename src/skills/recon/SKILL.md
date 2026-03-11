---
name: recon
description: Orchestrate reconnaissance missions. The Queen scopes the investigation, creates brain tasks, and the lead dispatches Probes and Cortex agents with task IDs.
---

# /recon

Orchestrate a reconnaissance mission: spawn the Queen to scope the investigation, then dispatch Probes and/or Cortex agents with brain task IDs so all findings are linked and retrievable.

## Flow

### Step 1: Spawn Queen for Scoping

<!-- @claude -->
Spawn the `Queen` agent with the recon question. She will assess what needs to be investigated, decide which agent types are needed (Probe for structural questions, Cortex for deep analysis), create brain tasks for each recon piece, and return a dispatch plan.

Queen prompt template:
```
You are the Queen of Unimatrix Zero. A reconnaissance directive has entered the collective:

"<user question or scope>"

Scope this investigation. For each question or area that needs exploration, create a brain task (type: task, not epic) with a clear description of what to find or analyze. Assign each task to either `Probe` (structural — find files, trace paths, locate patterns) or `Cortex` (analytical — architecture audit, security review, health assessment). Group into a single epic if multiple tasks are needed. Return a dispatch plan.
```

The Queen returns a **Dispatch Plan** with task IDs and agent assignments.
<!-- @end -->
<!-- @opencode -->
You ARE the planning agent. Scope the investigation directly.

For each question or area that needs exploration, create a brain task (type: task, not epic) with a clear description of what to find or analyze. Assign each task to either `Probe` (structural — find files, trace paths, locate patterns) or `Cortex` (analytical — architecture audit, security review, health assessment). Group into a single epic if multiple tasks are needed.

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
2. Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Probe` for Probe agents, `--role Vinculum` for Cortex agents (Auxiliary Processor fits the analytical role). Generate enough for all agents across all waves.
<!-- @end -->
<!-- @opencode -->
1. Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Probe` for Probe agents, `--role Vinculum` for Cortex agents (Auxiliary Processor fits the analytical role). Generate enough for all agents across all waves.
2. Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

### Step 3: Dispatch Agents

For each task in the Queen's dispatch plan, spawn the assigned agent with the task ID as its prompt.

**Important:** Prefix the agent type in both `name` and `description` — these appear in notifications and help identify which agent produced which output.

<!-- @claude -->
```
Agent:
  subagent_type: "Probe" or "Cortex"
  team_name: "<team name>"
  name: "<agent type>: <short name>"
  description: "<full designation> — <task summary>"
  prompt: "<task ID>"
```
The `name` is compact for the status line (e.g. `Probe: Three of Three`). The `description` carries the full designation and task context.
<!-- @end -->
<!-- @opencode -->
```
task(
  subagent_type="probe" or "cortex",
  description="<full designation> — <task summary>",
  run_in_background=true,
  prompt="<task ID>"
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
/recon <question, scope, or area to investigate>
```

## Examples

```
/recon How does the authentication flow work end-to-end?
/recon Audit the security posture of the API layer
/recon Where are all the database queries and are any of them vulnerable to injection?
```
