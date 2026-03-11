---
name: assemble
description: Assemble the collective to execute a complex task. The Queen plans, the lead dispatches Probes, Cortex, and Drones, Vinculum reviews.
---

# /assemble

Orchestrate a complex task end-to-end: the Queen assesses, recon runs if needed, the Queen plans, Drones implement, Vinculum reviews. The Queen persists across phases via resume — her context carries forward.

## Rules

- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.
- **Follow this flow exactly.** Do not insert your own recon, validation, or research steps. Do not read files, spawn agents, or search the codebase outside of the defined steps.
- **After any Queen call returns, go straight to the next defined step.** No side research, no "let me validate this first," no extra agents.
- **Save the Queen's agent ID** from Step 1. All subsequent Queen interactions use `resume` with this ID.

## Flow

### Step 1: Spawn Queen for Assessment

Spawn the `Queen` agent. She decides whether recon is needed based on the request and her existing knowledge — no deep exploration.

**Budget: ~10 tool uses.** The assessment should be fast. Check memory, glance at a README if needed, then decide. Do NOT explore unfamiliar codebases — that's what recon agents are for.

```
Agent:
  subagent_type: "Queen"
  prompt: |
    You are the Queen of Unimatrix Zero. A new directive has entered the collective:

    "<user request>"

    Assess whether reconnaissance is needed before you can plan this objective.
    Decide based on the request itself, your memory, and at most a glance at
    key files (e.g. a README). Do NOT explore unfamiliar codebases or trace
    implementation details — that is what Probe and Cortex agents do.

    BUDGET: ~10 tool uses. Be decisive.

    Do NOT produce a full plan yet. Return only your assessment:

    ## Assessment

    **Verdict:** RECON_NEEDED | SKIP_RECON

    ### Rationale
    <Why recon is or isn't needed — 2-3 sentences>

    ### Recon Questions (if RECON_NEEDED)
    1. <specific question> — Probe | Cortex
    2. <specific question> — Probe | Cortex

    Designate this objective. Begin at once.
```

**Save the returned agent ID.** The Queen returns one of:
- **SKIP_RECON** — proceed to Step 3.
- **RECON_NEEDED** with questions — proceed to Step 2.

### Step 2: Recon Phase (conditional)

Only if the Queen returned RECON_NEEDED.

#### Step 2a: Resume Queen for Recon Scoping

Resume the Queen with her agent ID. She already has the recon questions from her assessment — now she materializes them into brain tasks.

**Budget: ~15 tool uses.** She's creating tasks and wiring dependencies, not doing new research.

```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    A reconnaissance directive is now active for the objective you just assessed.

    Scope this investigation. For each recon question from your assessment,
    create a brain task (type: task, not epic) with a clear description of what
    to find or analyze. Assign each task to either `Probe` (structural — find
    files, trace paths, locate patterns) or `Cortex` (analytical — architecture
    audit, security review, health assessment). Group into a single epic if
    multiple tasks are needed. Return a recon dispatch plan.

    BUDGET: ~15 tool uses. You already have the questions — just create the
    tasks and return the dispatch plan.
```

The Queen creates recon brain tasks and returns a recon dispatch plan.

#### Step 2b: Dispatch Recon Agents

1. Create a team: `TeamCreate`
2. Generate designations: `/designate <count> --trimatrix` — use `--role Probe` for Probes, `--role Vinculum` for Cortex agents
3. Dispatch agents with their brain task IDs as prompts:
```
Agent:
  subagent_type: "Probe" or "Cortex"
  team_name: "<team name>"
  name: "<agent type>: <short name>"
  description: "<full designation> — <task summary>"
  prompt: "<task ID>"
  run_in_background: true
```
The `name` is compact for the status line (e.g. `Probe: Three of Three`). The `description` carries the full designation and task context.
4. Wait for all recon agents to complete

#### Step 2c: Collect Recon Results

Read each recon agent's completion comment on their brain task to extract snapshot IDs.

### Step 3: Resume Queen for Planning

Resume the Queen. She has her full assessment context (and recon scoping context if Step 2 ran). Now she produces the implementation plan.

If recon was performed:
```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    Reconnaissance is complete. The following snapshots contain the findings:
    RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>

    Use `records_fetch_content` to review the recon findings. Then produce the
    implementation plan — proceed through your full planning phases (plan,
    materialize, dispatch plan). The dispatch plan should contain only Drone
    waves — all reconnaissance is already complete.
```

If recon was skipped:
```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    Produce the implementation plan. Proceed through your full planning phases
    (plan, materialize, dispatch plan).
```

The Queen returns a **Dispatch Plan** with the epic task ID, wave structure, and Drone assignments.

### Step 3b: Present the Plan

After the Queen returns the implementation plan, present the dispatch plan to the user for review. Summarize the waves, task assignments, and file partitions clearly. Wait for the user to approve before proceeding.

### Step 4: Create Team and Generate Designations

If a team was already created in Step 2b, reuse it. Otherwise:

1. Create a team: `TeamCreate` with a descriptive `team_name`
2. Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Drone` for implementation agents, `--role Vinculum` for the Vinculum. Generate enough for all agents across all waves, including the Vinculum.

### Step 5: Dispatch Drones

For each wave in the Queen's dispatch plan, spawn Drones as team members.

**Important:** Prefix the agent type in both `name` and `description` — these appear in notifications and help identify which agent produced which output.

```
Agent:
  subagent_type: "Drone"
  team_name: "<team name>"
  name: "Drone: <short name>"
  description: "<full designation> — <task summary>"
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

After a wave completes, read each Drone's completion comment to extract snapshot IDs. Pass them to the next wave:
```
PRIOR CHECKPOINTS: <snapshot-id-1>, <snapshot-id-2>
RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>
```

**Spawning rules:**
- Parallel wave: spawn all Drones with `run_in_background: true`
- Sequential wave: spawn one Drone, wait for completion
- Wait for all Drones in a wave to complete before starting the next wave

### Step 6: Monitor

- Drones send idle notifications when done — you'll be notified automatically
- Check brain tasks for completion status
- If a Drone marks a task `blocked`, assess and either re-dispatch or escalate to the user

### Step 7: Review

When all Drones complete, spawn a `Vinculum` agent:
```
Agent:
  subagent_type: "Vinculum"
  name: "Vinculum: <short name>"
  description: "<full designation> — review"
  prompt: "<parent task ID>"
```

### Step 8: Handle Verdict

- **PASS** — Close all subtasks and the parent task via `tasks_close`. Write collective memory via `memory_write_episode`. Clean up the team.
- **NEEDS_CHANGES** — Spawn new Drones to fix specific issues, then re-run Vinculum.
- **BLOCK** — Report blockers to user.

### Step 9: Cleanup

1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`

## Ad-Hoc Reconnaissance

If the lead needs to search the codebase during orchestration (e.g. to gather context between waves or verify something before dispatching), always use `Probe` agents — never `Explore`.

## Post-Wave Git Discipline

- **File-partitioned Drones:** No merge needed — changes are on the main tree.
- **Worktree Drones:** Squash-merge branches before the next wave (`git merge --squash <branch>`). On conflict: abort, dispatch a Drone to rebase, retry.
- **Sequential Drones:** No merge needed — Drones run serially.

## Usage

```
/assemble <description of what you want to accomplish>
```
