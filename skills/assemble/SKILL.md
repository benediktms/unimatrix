---
name: assemble
description: Assemble the collective to execute a complex task. The Queen plans, the lead dispatches Probes, Cortex, and Drones, Vinculum reviews.
---

# /assemble

Orchestrate a complex task end-to-end: spawn the Queen for planning, then execute her dispatch plan by creating a team of agents (Probes for recon, Cortex for analysis, Drones for implementation).

## Flow

### Step 1: Spawn Queen for Planning

Spawn the `Queen` agent with the user's request. She will research the codebase, produce a plan, create brain tasks (with subtasks and dependencies), and return a structured dispatch plan.

Queen prompt template:
```
You are the Queen of Unimatrix Zero. A new directive has entered the collective:

"<user request>"

Designate this objective. Begin at once.
```

The Queen returns a **Dispatch Plan** containing the parent task ID, wave structure, and task assignments.

### Step 1b: Enter Plan Mode

After the Queen returns, immediately call `EnterPlanMode`. Present the dispatch plan for review — this lets the user see the full plan before execution begins. When the plan is approved and `ExitPlanMode` fires, the checkpoint hook captures the epic and subtask state as a **plan checkpoint**.

### Step 2: Create Team and Generate Designations

1. Create a team: `TeamCreate` with a descriptive `team_name`
2. Generate designations: `/designate <total-agent-count> --trimatrix` — always use `--trimatrix` so spawned agents get Trimatrix designations (Unimatrix Zero is the lead session). Use `--role Drone` for implementation agents, `--role Probe` for recon Probes, `--role Vinculum` for Cortex and Vinculum agents. Generate enough for all agents across all waves, including the Vinculum.

### Step 3: Dispatch Agents

For each wave in the Queen's dispatch plan, spawn agents as team members. The agent type comes from the task's assignee in the dispatch plan: `Probe`, `Cortex`, or `Drone`.

**Important:** Always use the designation (not "Drone A/B") in both `name` and `description` — these appear in notifications and help identify which agent produced which output.

**For Probes and Cortex (recon waves):**
```
Agent:
  subagent_type: "Probe" or "Cortex"
  team_name: "<team name>"
  name: "<designation>"
  description: "<short designation> — <task summary>"
  prompt: "<task ID>"
```

Recon agents accept a task ID as their prompt — they load the task, do the work, and save artifacts linked to it.

**For Drones (implementation waves):**
```
Agent:
  subagent_type: "Drone"
  team_name: "<team name>"
  name: "<designation>"
  description: "<short designation> — <task summary>"
  prompt: |
    You are Drone <designation> executing brain task <task-id> — "<task title>".
    <mode block if applicable>
    <prior checkpoints if applicable>
    <recon snapshots if applicable>
```

**Mode blocks — append based on wave type:**

For **parallel waves** with non-overlapping files:
```
FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other Drones are working on other files in parallel — touching their files will cause conflicts.
```

For **sequential waves**, no special block needed.

**Prior checkpoints and recon snapshots:**

After a wave completes, read each agent's completion comment to extract snapshot IDs. Pass them to the next wave:
```
PRIOR CHECKPOINTS: <snapshot-id-1>, <snapshot-id-2>
RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>
```

**Spawning rules:**
- Parallel wave: spawn all agents with `run_in_background: true`
- Sequential wave: spawn one agent, wait for completion
- Wait for all agents in a wave to complete before starting the next wave

### Step 4: Monitor

- Drones send idle notifications when done — you'll be notified automatically
- Check brain tasks for completion status
- If a Drone marks a task `blocked`, assess and either re-dispatch or escalate to the user

### Step 5: Review

When all Drones complete, spawn a `Vinculum` agent:
```
Agent:
  subagent_type: "Vinculum"
  name: "<designation from the pre-generated batch>"
  prompt: "<parent task ID>"
```

### Step 6: Handle Verdict

- **PASS** — Close all subtasks and the parent task via `tasks_close`. Write collective memory via `memory_write_episode`. Clean up the team.
- **NEEDS_CHANGES** — Spawn new Drones to fix specific issues, then re-run Vinculum.
- **BLOCK** — Report blockers to user.

### Step 7: Cleanup

1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`

## Reconnaissance

When the lead needs to search the codebase during orchestration (e.g. to gather context between waves, verify file locations, or answer questions before dispatching), always use `Probe` agents — never `Explore`. Probes have LSP, web search, and memory access, making them strictly superior for reconnaissance during assembly.

Both Probes and Cortex agents save their findings as brain snapshots (`probe-recon` / `cortex-analysis` tags). When dispatching Drones that depend on reconnaissance results, include the snapshot IDs in their prompts alongside any prior checkpoints:
```
RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>
```

## Post-Wave Git Discipline

- **File-partitioned Drones:** No merge needed — changes are on the main tree.
- **Worktree Drones:** Squash-merge branches before the next wave (`git merge --squash <branch>`). On conflict: abort, dispatch a Drone to rebase, retry.
- **Sequential Drones:** No merge needed — Drones run serially.

## Usage

```
/assemble <description of what you want to accomplish>
```
