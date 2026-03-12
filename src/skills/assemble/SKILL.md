---
name: assemble
description: Assemble the collective to execute a complex task in an isolated worktree. The planner assesses, plans, and the lead dispatches Probes, Cortex, and Drones using sequential, sequence, or swarm dispatch strategies. Vinculum reviews. Changes merge back on completion.
---

# /assemble

<!-- @claude -->
Orchestrate a complex task end-to-end in an isolated worktree: the Queen assesses, recon runs if needed, the Queen plans, a worktree is created, Drones implement, Vinculum reviews, and changes merge back to the main branch. The Queen persists across phases via resume — her context carries forward.
<!-- @end -->
<!-- @opencode -->
Orchestrate a complex task end-to-end in an isolated worktree: you assess, recon runs if needed, you plan, a worktree is created, Drones implement, Vinculum reviews, and changes merge back to the main branch. You maintain full context throughout — no subagent management needed.
<!-- @end -->

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Rules

- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.
- **Follow this flow exactly.** Do not insert your own recon, validation, or research steps. Do not read files, spawn agents, or search the codebase outside of the defined steps.
<!-- @claude -->
- **After any Queen call returns, go straight to the next defined step.** No side research, no "let me validate this first," no extra agents.
<!-- @end -->
<!-- @opencode -->
- **After each step, go straight to the next defined step.** No side research, no "let me validate this first," no extra agents.
<!-- @end -->
<!-- @claude -->
- **Save the Queen session ID** from Step 1. Reuse it for all subsequent Queen interactions.
<!-- @end -->
<!-- @opencode -->
- **You maintain context throughout** — no session management needed.
<!-- @end -->

## Dispatch Modes

<!-- @claude -->
The Queen's dispatch plan specifies one of three modes for each wave of work:
<!-- @end -->
<!-- @opencode -->
Your dispatch plan specifies one of three modes for each wave of work:
<!-- @end -->

<!-- @claude -->
### Sequential (queen-supervised)
Steps have dependencies — drones execute in waves, the queen stays alive to monitor progress and pass context between waves. Use when the plan requires dynamic re-planning based on intermediate results or when the queen needs to make decisions between steps.

**Use when:** short chains (2-3 steps), steps where intermediate results may change subsequent steps, orchestrations requiring queen judgment between waves.
<!-- @end -->
<!-- @opencode -->
### Sequential (direct supervision)
Steps have dependencies — drones execute in waves, you stay alive to monitor progress and pass context between waves. Use when the plan requires dynamic re-planning based on intermediate results or when you need to make decisions between steps.

**Use when:** short chains (2-3 steps), steps where intermediate results may change subsequent steps, orchestrations requiring your judgment between waves.
<!-- @end -->

**Avoid when:** chains are long (3+ steps) and each step's output can be summarized concisely — use sequence instead.

### Sequence (relay)
<!-- @claude -->
Steps have dependencies — drones execute one at a time, each passing a handoff snapshot to the next via Brain records. The queen dispatches but does not stay alive for the happy path.

**Use when:** long sequential chains (3+ steps), orchestrations where queen compaction is a risk, chains where each step's context can be summarized concisely for the next.

**Avoid when:** steps require dynamic re-planning based on results, the queen needs to make decisions between steps, chains are short (2 steps — just use sequential).
<!-- @end -->
<!-- @opencode -->
Steps have dependencies — drones execute one at a time, each passing a handoff snapshot to the next via Brain records. You dispatch but do not stay alive for the happy path.

**Use when:** long sequential chains (3+ steps), orchestrations where context compaction is a risk, chains where each step's context can be summarized concisely for the next.

**Avoid when:** steps require dynamic re-planning based on results, you need to make decisions between steps, chains are short (2 steps — just use sequential).
<!-- @end -->

### Swarm
Steps are independent — drones execute in parallel with non-overlapping file partitions. Use when work can be divided by file group with no cross-group dependencies.

**Use when:** bulk changes across many files, parallel implementation of independent features, migrations or convention enforcement across the codebase.

**Avoid when:** steps share files or have dependencies between them.

## Flow

<!-- @claude -->
### Step 1: Spawn Queen for Assessment

Spawn the `Queen` agent. She decides whether recon is needed based on the request and her existing knowledge — no deep exploration.

**Budget: ~10 tool uses.** The assessment should be fast. Check memory, glance at a README if needed, then decide. Do NOT explore unfamiliar codebases — that's what recon agents are for.

<!-- @end -->
<!-- @opencode -->
### Step 1: Assessment

Assess whether reconnaissance is needed based on the request, your memory, and at most a glance at key files. Do NOT explore unfamiliar codebases — that is what Probe and Cortex agents do.

**Budget: ~10 tool uses.** Be decisive.

Return your assessment:

## Assessment

**Verdict:** RECON_NEEDED | SKIP_RECON

### Rationale
<Why recon is or isn't needed — 2-3 sentences>

### Recon Questions (if RECON_NEEDED)
1. <specific question> — Probe | Cortex
2. <specific question> — Probe | Cortex
<!-- @end -->
<!-- @claude -->
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
<!-- @end -->

<!-- @claude -->
**Save the returned agent ID.** The Queen returns one of:
<!-- @end -->
<!-- @opencode -->
**The assessment result is available directly.** Your verdict is one of:
<!-- @end -->
- **SKIP_RECON** — proceed to Step 3.
- **RECON_NEEDED** with questions — proceed to Step 2.

### Step 2: Recon Phase (conditional)

<!-- @claude -->
Only if the Queen returned RECON_NEEDED.
<!-- @end -->
<!-- @opencode -->
Only if your verdict was RECON_NEEDED.
<!-- @end -->

<!-- @claude -->
#### Step 2a: Resume Queen for Recon Scoping

Resume the Queen with her agent ID. She already has the recon questions from her assessment — now she materializes them into brain tasks.

**Budget: ~15 tool uses.** She's creating tasks and wiring dependencies, not doing new research.
<!-- @end -->
<!-- @opencode -->
#### Step 2a: Recon Scoping

You already have the recon questions from your assessment — now materialize them into brain tasks.

**Budget: ~15 tool uses.** You're creating tasks and wiring dependencies, not doing new research.

Scope the investigation directly. For each recon question from your assessment, create a brain task with a clear description. Assign each to `Probe` or `Cortex`. Group into a single epic if multiple tasks are needed. Produce the recon dispatch plan.
<!-- @end -->
<!-- @claude -->
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
<!-- @end -->

<!-- @claude -->
The Queen creates recon brain tasks and returns a recon dispatch plan.
<!-- @end -->
<!-- @opencode -->
Create the recon brain tasks and produce a recon dispatch plan.
<!-- @end -->

#### Step 2b: Dispatch Recon Agents

1. Generate designations: `/designate <count> --trimatrix` — use `--role Probe` for Probes, `--role Cortex` for Cortex agents
<!-- @claude -->
2. Create a team: `TeamCreate`
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
<!-- @end -->
<!-- @opencode -->
2. Coordination happens through Brain tasks and records. No team management needed.
3. Dispatch agents with their brain task IDs as prompts:
```
task(
  subagent_type="probe" or "cortex",
  description="<agent type>: <short name>",
  run_in_background=true,
  prompt="<task ID>"
)
```
Use `description="<full designation> — <task summary>"` to carry designation and task context.
4. Wait for all recon agents to complete
<!-- @end -->

#### Step 2c: Collect Recon Results

Read each recon agent's completion comment on their brain task to extract snapshot IDs.

<!-- @claude -->
### Step 3: Resume Queen for Planning

Resume the Queen. She has her full assessment context (and recon scoping context if Step 2 ran). Now she produces the implementation plan.
<!-- @end -->
<!-- @opencode -->
### Step 3: Implementation Planning

You have your full assessment context (and recon scoping context if Step 2 ran). Now produce the implementation plan.
<!-- @end -->

If recon was performed:
<!-- @claude -->
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
<!-- @end -->
<!-- @opencode -->
Review the recon findings via `records_fetch_content` on the snapshot IDs. Then produce the implementation plan — proceed through your full planning phases (plan, materialize, dispatch plan). The dispatch plan should contain only Drone waves — all reconnaissance is already complete.
<!-- @end -->

If recon was skipped:
<!-- @claude -->
```
Agent:
  subagent_type: "Queen"
  resume: "<queen agent ID>"
  prompt: |
    Produce the implementation plan. Proceed through your full planning phases
    (plan, materialize, dispatch plan).
```
<!-- @end -->
<!-- @opencode -->
Produce the implementation plan. Proceed through your full planning phases (plan, materialize, dispatch plan).
<!-- @end -->

<!-- @claude -->
The Queen returns a **Dispatch Plan** with the epic task ID, wave structure, and Drone assignments.
<!-- @end -->
<!-- @opencode -->
Produce a **Dispatch Plan** with the epic task ID, wave structure, and Drone assignments.
<!-- @end -->

### Step 3b: Present the Plan

<!-- @claude -->
After the Queen returns the implementation plan, present the dispatch plan to the user for review.
<!-- @end -->
<!-- @opencode -->
After producing the implementation plan, present the dispatch plan to the user for review.
<!-- @end -->

Summarize the waves, task assignments, and file partitions clearly. Wait for the user to approve before proceeding.

### Step 3c: Enter Worktree

Create an isolated worktree for the implementation. Use the branch name from the Queen's dispatch plan (the `Worktree` section):

<!-- @claude -->
```
EnterWorktree:
  name: "<branch name from dispatch plan>"
```
<!-- @end -->
<!-- @opencode -->
```bash
git worktree add ../<branch-name> -b <branch-name>
cd ../<branch-name>
```
<!-- @end -->

All subsequent steps (drone dispatch, verification, review) execute inside this worktree. The main branch remains clean until the user chooses to merge.

After entering the worktree, link it to the brain so that agents spawned inside the worktree can access brain tasks and records:

```bash
brain link <brain-name>
```

Where `<brain-name>` is the brain that the Queen created tasks in (visible in the Queen's dispatch plan or from the parent repo's `.brain/brain.toml`). This must run **after** the worktree exists and from **inside** the worktree directory.

### Step 4: Create Team and Generate Designations

<!-- @claude -->
If a team was already created in Step 2b, reuse it. Otherwise:

1. Create a team: `TeamCreate` with a descriptive `team_name`
2. Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Drone` for implementation agents, `--role Vinculum` for the Vinculum. Generate enough for all agents across all waves, including the Vinculum.
<!-- @end -->
<!-- @opencode -->
Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Drone` for implementation agents, `--role Vinculum` for the Vinculum. Generate enough for all agents across all waves, including the Vinculum.

Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

### Step 5: Dispatch Adjuncts

<!-- @claude -->
For each wave in the Queen's dispatch plan, spawn agents as team members. Use `Drone` for implementation tasks and `Subroutine` for documentation-only tasks.
<!-- @end -->
<!-- @opencode -->
For each wave in your dispatch plan, spawn agents. Use `Drone` for implementation tasks and `Subroutine` for documentation-only tasks.
<!-- @end -->

**Important:** Prefix the agent type in both `name` and `description` — these appear in notifications and help identify which agent produced which output.

<!-- @claude -->
```
Agent:
  subagent_type: "Drone" or "Subroutine"
  team_name: "<team name>"
  name: "<agent type>: <short name>"
  description: "<full designation> — <task summary>"
  prompt: |
    You are <agent type> <designation> executing brain task <task-id> — "<task title>".
    <mode block if applicable>
    <prior checkpoints if applicable>
    <recon snapshots if applicable>
```
<!-- @end -->
<!-- @opencode -->
```
task(
  subagent_type="drone" or "subroutine",
  description="<agent type>: <short name>",
  run_in_background=true,
  prompt="""
You are <agent type> <designation> executing brain task <task-id> — \"<task title>\".
<mode block if applicable>
<prior checkpoints if applicable>
<recon snapshots if applicable>
"""
)
```
Use `description="<full designation> — <task summary>"` to carry designation and task context.
<!-- @end -->

**Mode blocks — append based on wave type (sequential, sequence, or swarm):**

For **swarm waves** with non-overlapping files:
```
FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other Drones are working on other files in parallel — touching their files will cause conflicts.
```

For **sequential waves** or **sequence relay**, no special block needed.

**Prior checkpoints and recon snapshots:**

After a wave completes, read each Drone's completion comment to extract snapshot IDs. Pass them to the next wave:
```
PRIOR CHECKPOINTS: <snapshot-id-1>, <snapshot-id-2>
RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>
```

**Spawning rules:**
- Swarm wave: spawn all Drones with `run_in_background: true`
- Sequential wave: spawn one Drone, wait for completion
- Sequence relay: spawn one Drone, wait for completion, extract its snapshot ID and pass as `PRIOR CHECKPOINTS:` to the next Drone
- Wait for all Drones in a wave to complete before starting the next wave

### Step 6: Monitor

- Drones send idle notifications when done — you'll be notified automatically
- Check brain tasks for completion status
- If a Drone marks a task `blocked`, assess and either re-dispatch or escalate to the user

### Step 7: Verification Gate

When all Drones complete, the lead runs tests, lint, and formatting globally for the affected codebase. Drones only verify their own changed files — this step catches cross-cutting failures.

1. **Run tests** — Execute the project's test suite covering all areas affected by Drone changes.
2. **Run lint and formatting** — Execute the project's linter and formatter across all changed files.
3. **If all pass** — Proceed to Step 8.
4. **If failures exist** — Dispatch a single fix Drone:
   - Create a brain task under the parent epic containing the raw test/lint/formatting error output and the specific files that need fixing.
   - Save the failure output as an artifact (`records_create_artifact`, kind `"verification-failures"`) linked to the fix task.
   - Dispatch one Drone to fix all test, lint, and formatting failures in a single pass.
   - After the fix Drone completes, re-run the failing commands. If still failing, repeat (max 2 fix cycles total). If still failing after 2 cycles, escalate to the user.

### Step 8: Review

When verification passes, spawn a `Vinculum` agent:
<!-- @claude -->
```
Agent:
  subagent_type: "Vinculum"
  name: "Vinculum: <short name>"
  description: "<full designation> — review"
  prompt: "<parent task ID>"
```
<!-- @end -->
<!-- @opencode -->
```
task(
  subagent_type="vinculum",
  description="<full designation> — review",
  run_in_background=true,
  prompt="<parent task ID>"
)
```
<!-- @end -->

### Step 9: Handle Verdict

- **PASS** — Close all subtasks and the parent task via `tasks_close`. Write collective memory via `memory_write_episode`. Proceed to Step 9b.
- **NEEDS_CHANGES** — Spawn new Drones to fix specific issues, then re-run Vinculum.
- **BLOCK** — Report blockers to user.

### Step 9b: Worktree Merge

After Vinculum passes and all tasks are closed:

<!-- @claude -->
1. Exit the worktree (keep it for merge):
   ```
   ExitWorktree:
     action: "keep"
   ```
<!-- @end -->
<!-- @opencode -->
1. Return to the main branch:
   ```bash
   cd <original-repo-path>
   ```
<!-- @end -->
2. Present the change summary: `git diff --stat main..<worktree-branch>`
3. Ask the user what to do:
   - **Merge now** — squash-merge the worktree branch, then clean up
   - **Keep worktree** — leave it on disk for manual review or later merging
   - **Discard** — remove the worktree and its branch entirely

#### If merge:
```bash
git merge --squash <branch-name>
git commit -m "<conventional commit message based on the work done>"
git worktree remove <worktree-path>
git branch -d <branch-name>
```

#### If keep:
Report the worktree path and branch name so the user can return later.

#### If discard:
<!-- @claude -->
```
ExitWorktree:
  action: "remove"
  discard_changes: true
```
<!-- @end -->
<!-- @opencode -->
```bash
git worktree remove <worktree-path>
git branch -D <branch-name>
```
<!-- @end -->

### Step 10: Cleanup

<!-- @claude -->
1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team management needed.
<!-- @end -->

## Ad-Hoc Reconnaissance

<!-- @claude -->
If the queen needs to search the codebase during orchestration (e.g. to gather context between waves or verify something before dispatching), always use `Probe` agents — never `Explore`.
<!-- @end -->
<!-- @opencode -->
If you need to search the codebase during orchestration (e.g. to gather context between waves or verify something before dispatching), always use `Probe` agents — never `Explore`.
<!-- @end -->

## Post-Wave Git Discipline

All Drones work inside the orchestration worktree created in Step 3c. Commits land on the worktree branch.

- **Swarm Drones (file-partitioned):** No merge needed — changes are on the worktree branch.
- **Worktree Drones (per-drone isolation):** Squash-merge per-drone branches back to the orchestration worktree branch before the next wave (`git merge --squash <branch>`). On conflict: abort, dispatch a Drone to rebase, retry.
- **Sequential Drones:** No merge needed — Drones run serially on the worktree branch.
- **Sequence relay Drones:** No merge needed — Drones run serially on the worktree branch. Context flows via Brain snapshots.

## Usage

```
/assemble <description of what you want to accomplish>
```
