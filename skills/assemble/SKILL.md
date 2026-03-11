---
name: assemble
description: Assemble the collective to execute a complex task. The queen plans, the lead dispatches a team of drones, vinculum reviews.
---

# /assemble

Orchestrate a complex task end-to-end: spawn the queen for planning, then execute her dispatch plan by creating a team of drones.

## Flow

### Step 1: Spawn Queen for Planning

Spawn the `queen` agent with the user's request. She will research the codebase, produce a plan, create brain tasks (with subtasks and dependencies), and return a structured dispatch plan.

Queen prompt template:
```
You are the Queen of Unimatrix Zero. A new directive has entered the collective:

"<user request>"

Designate this objective. Begin at once.
```

The queen returns a **Dispatch Plan** containing the parent task ID, wave structure, and task assignments.

### Step 2: Create Team and Generate Designations

1. Create a team: `TeamCreate` with a descriptive `team_name`
2. Generate designations: `/designate <total-agent-count> --role drone --trimatrix` — always use `--trimatrix` so spawned agents get Trimatrix designations (Unimatrix Zero is the lead session). Generate enough for all agents across all waves, including the vinculum.

### Step 3: Dispatch Drones

For each wave in the queen's dispatch plan, spawn drones as team members.

**Important:** Always use the designation (not "Drone A/B") in both `name` and `description` — these appear in notifications and help identify which drone produced which output.

```
Agent:
  subagent_type: "drone"
  team_name: "<team name>"
  name: "<designation>"
  description: "<short designation> — <task summary>"
  prompt: |
    You are Drone <designation> executing brain task <task-id> — "<task title>".
    <mode block if applicable>
    <prior checkpoints if applicable>
```

**Mode blocks — append based on wave type:**

For **parallel waves** with non-overlapping files:
```
FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other drones are working on other files in parallel — touching their files will cause conflicts.
```

For **sequential waves**, no special block needed.

**Prior checkpoints — for waves that depend on earlier waves:**

After a wave completes, read each drone's completion comment to extract snapshot IDs. Pass them to the next wave's drones:
```
PRIOR CHECKPOINTS: <snapshot-id-1>, <snapshot-id-2>
```

**Spawning rules:**
- Parallel wave: spawn all drones with `run_in_background: true`
- Sequential wave: spawn one drone, wait for completion
- Wait for all drones in a wave to complete before starting the next wave

### Step 4: Monitor

- Drones send idle notifications when done — you'll be notified automatically
- Check brain tasks for completion status
- If a drone marks a task `blocked`, assess and either re-dispatch or escalate to the user

### Step 5: Review

When all drones complete, spawn a `vinculum` agent:
```
Agent:
  subagent_type: "vinculum"
  name: "<designation from the pre-generated batch>"
  prompt: "<parent task ID>"
```

### Step 6: Handle Verdict

- **PASS** — Close all subtasks and the parent task via `tasks_close`. Write collective memory via `memory_write_episode`. Clean up the team.
- **NEEDS_CHANGES** — Spawn new drones to fix specific issues, then re-run vinculum.
- **BLOCK** — Report blockers to user.

### Step 7: Cleanup

1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`

## Post-Wave Git Discipline

- **File-partitioned drones:** No merge needed — changes are on the main tree.
- **Worktree drones:** Squash-merge branches before the next wave (`git merge --squash <branch>`). On conflict: abort, dispatch a drone to rebase, retry.
- **Sequential drones:** No merge needed — drones run serially.

## Usage

```
/assemble <description of what you want to accomplish>
```
