---
name: assemble
description: Assemble the collective to execute a complex task in an isolated worktree. The planner assesses, plans, and the Queen dispatches Probes, Cortex, and Drones using sequential, sequence, swarm, or collaborative dispatch strategies. Vinculum reviews. Changes merge back on completion.
---

# /assemble

<!-- @claude -->
Orchestrate a complex task end-to-end in an isolated worktree: you assess, recon runs if needed, you plan, a worktree is created, Drones implement, Vinculum reviews, and changes merge back to the main branch. You maintain full context throughout.
<!-- @end -->
<!-- @opencode -->
Orchestrate a complex task end-to-end in an isolated worktree: you assess, recon runs if needed, you plan, a worktree is created, Drones implement, Vinculum reviews, and changes merge back to the main branch. You maintain full context throughout — no subagent management needed.
<!-- @end -->

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Rules

- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.
- **Follow this flow exactly.** Do not insert your own recon, validation, or research steps. Do not read files, spawn agents, or search the codebase outside of the defined steps.
- **After each step, go straight to the next defined step.** No side research, no "let me validate this first," no extra agents.
- **You maintain context throughout** — no session management needed.

## Dispatch Modes

Your dispatch plan specifies one of four modes for each wave of work:

### Sequential (direct supervision)
Steps have dependencies — drones execute in waves, you stay alive to monitor progress and pass context between waves. Use when the plan requires dynamic re-planning based on intermediate results or when you need to make decisions between steps.

**Use when:** short chains (2-3 steps), steps where intermediate results may change subsequent steps, orchestrations requiring your judgment between waves.

**Avoid when:** chains are long (3+ steps) and each step's output can be summarized concisely — use sequence instead.

### Sequence (relay)
Steps have dependencies — drones execute one at a time, each passing a handoff snapshot to the next via Brain records. You dispatch but do not stay alive for the happy path.

**Use when:** long sequential chains (3+ steps), orchestrations where context compaction is a risk, chains where each step's context can be summarized concisely for the next.

**Avoid when:** steps require dynamic re-planning based on results, you need to make decisions between steps, chains are short (2 steps — just use sequential).

### Swarm
Steps are independent — drones execute in parallel with non-overlapping file partitions. No inter-drone communication. Use when work can be divided by file group with no cross-group dependencies.

**Use when:** bulk changes across many files, parallel implementation of independent features, migrations or convention enforcement across the codebase.

**Avoid when:** steps share files or have dependencies between them, or when decisions in one partition affect another.

### Collaborative
<!-- @claude -->
Drones work in parallel on related but non-overlapping files, communicating via an agent team. Unlike swarm (parallel, silent) or sequential (serial, Queen-mediated), collaborative Drones share decisions in real-time. File partitions are still enforced — each Drone owns its files — but Drones coordinate on shared interfaces, contracts, and assumptions.

**Use when:** cross-layer changes where decisions in one area affect another — e.g., API contract changes that frontend and backend must agree on, schema changes that affect multiple consumers, shared type definitions used across modules.

**Avoid when:** changes are truly independent (use swarm) or must be strictly ordered (use sequential/sequence).
<!-- @end -->
<!-- @opencode -->
Drones work in parallel on related but non-overlapping files, coordinating via brain snapshots. File partitions are still enforced — each Drone owns its files — but Drones save decision snapshots that other Drones can reference.

**Use when:** cross-layer changes where decisions in one area affect another — e.g., API contract changes that frontend and backend must agree on, schema changes that affect multiple consumers.

**Avoid when:** changes are truly independent (use swarm) or must be strictly ordered (use sequential/sequence).
<!-- @end -->

## Flow

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

**The assessment result is available directly.** Your verdict is one of:
- **SKIP_RECON** — proceed to Step 3.
- **RECON_NEEDED** with questions — proceed to Step 2.

### Step 2: Recon Phase (conditional)

Only if your verdict was RECON_NEEDED.

This phase uses the **`/scan` pattern** by default — independent subagents, no team communication. If recon questions are cross-cutting (one agent's findings would change another's investigation), use the **`/recon` pattern** instead — create a team via `TeamCreate` and spawn agents with `team_name` so they can share discoveries in real-time.

**Default: `/scan` pattern.** Upgrade to `/recon` pattern only when agents must coordinate.

#### Step 2a: Recon Scoping

You already have the recon questions from your assessment — now materialize them into brain tasks.

**Budget: ~15 tool uses.** You're creating tasks and wiring dependencies, not doing new research.

Scope the investigation directly. For each recon question from your assessment, create a brain task with a clear description. Assign each to `Probe` or `Cortex`. Group into a single epic if multiple tasks are needed. Produce the recon dispatch plan.

Create the recon brain tasks and produce a recon dispatch plan.

#### Step 2b: Dispatch Recon Agents

1. Generate designations: `/designate <count> --trimatrix` — use `--role Probe` for Probes, `--role Cortex` for Cortex agents
<!-- @claude -->
2. Dispatch agents with their brain task IDs as prompts:
```
Agent:
  subagent_type: "adjunct-reconnaissance-protocol" or "adjunct-tactical-analysis-protocol"
  name: "<agent type>: <short name>"
  description: "<full designation> — <task summary>"
  prompt: "<task ID>"
  run_in_background: true
```
The `name` is compact for the status line (e.g. `Probe: Three of Three`). The `description` carries the full designation and task context.
3. Wait for all recon agents to complete
<!-- @end -->
<!-- @opencode -->
2. Coordination happens through Brain tasks and records. No team management needed.
3. Dispatch agents with their brain task IDs as prompts:
```
task(
  subagent_type="adjunct-reconnaissance-protocol" or "adjunct-tactical-analysis-protocol",
  description="<agent type>: <short name>",
  run_in_background=true,
  prompt="<task ID>"
)
```
Use `description="<full designation> — <task summary>"` to carry designation and task context.
4. Wait for all recon agents to complete
<!-- @end -->

#### Step 2c: Collect Recon Intelligence

Read each recon agent's completion comment on their brain task to extract snapshot IDs. Fetch each snapshot via `records_fetch_content` and distill into a recon intelligence summary:

- **Key findings** — one line per snapshot summarizing the discovery
- **Key files** — `file:line-range` with why each matters to the implementation
- **Decisions** — constraints or architectural facts discovered during recon

This intelligence feeds directly into the implementation plan and dispatch brief. Do not re-read the files the recon agents already examined — their findings are authoritative.

### Step 3: Implementation Planning

You have your full assessment context (and recon intelligence if Step 2 ran). Now produce the implementation plan.

If recon was performed:

Use the recon intelligence distilled in Step 2c — do not re-fetch snapshots or re-read files the recon agents already examined. Produce the implementation plan — proceed through your full planning phases (plan, materialize, dispatch plan, **dispatch brief**). The dispatch plan should contain only Drone waves — all reconnaissance is already complete.

If recon was skipped:

Produce the implementation plan. Proceed through your full planning phases (plan, materialize, dispatch plan, **dispatch brief**).

Produce a **Dispatch Plan** with the epic task ID, wave structure, and Drone assignments.

### Step 3b: Present the Plan

After producing the implementation plan, present the dispatch plan to the user for review.

Summarize the waves, task assignments, and file partitions clearly. Wait for the user to approve before proceeding.

### Step 3c: Enter Worktree

Create an isolated worktree for the implementation. Use the branch name from the dispatch plan (the `Worktree` section):

<!-- @claude -->
```
EnterWorktree:
  name: "<branch name from dispatch plan>"
```
<!-- @end -->
<!-- @opencode -->
```bash
mkdir -p .claude/worktrees
git worktree add .claude/worktrees/<branch-name> -b <branch-name>
cd .claude/worktrees/<branch-name>
```
<!-- @end -->

All subsequent steps (drone dispatch, verification, review) execute inside this worktree. The main branch remains clean until the user chooses to merge.

After entering the worktree, link it to the brain so that agents spawned inside the worktree can access brain tasks and records. Call `mcp__unimatrix__brain_link` with `name` set to the brain name (visible in the dispatch plan or from the parent repo's `.brain/brain.toml`) and `cwd` set to the worktree directory.

### Step 4: Generate Designations

Generate designations: `/designate <total-agent-count> --trimatrix` — use `--role Drone` for implementation agents, `--role Vinculum` for the Vinculum. Generate enough for all agents across all waves, including the Vinculum.

### Step 5: Dispatch Adjuncts

For each wave in your dispatch plan, spawn agents. Use `Drone` for implementation tasks and `Subroutine` for documentation-only tasks.

**Important:** Prefix the agent type in both `name` and `description` — these appear in notifications and help identify which agent produced which output.

<!-- @claude -->
```
Agent:
  subagent_type: "adjunct-assimilation-protocol" or "adjunct-closure-protocol"
  name: "<agent type>: <short name>"
  description: "<full designation> — <task summary>"
  run_in_background: true  # for swarm waves; false for sequential
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
  subagent_type="adjunct-assimilation-protocol" or "adjunct-closure-protocol",
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

**Mode blocks — append based on wave type:**

For **swarm waves** with non-overlapping files:
```
FILE PARTITION ACTIVE. You may ONLY read, edit, or create files listed in your task's "Files" section. Do NOT modify any file outside your partition. Other Drones are working on other files in parallel — touching their files will cause conflicts.
```

<!-- @claude -->
For **collaborative waves** with non-overlapping files and team communication:
```
COLLABORATIVE MODE ACTIVE. You may ONLY edit files listed in your task's
"Files" section. Other Drones own other files — do NOT touch them.

You are part of a team. Communicate actively:
- ANNOUNCE DECISIONS: When you make a decision that affects shared interfaces,
  contracts, types, or assumptions, message ALL teammates immediately.
  Example: "Changed UserResponse to include `lastLogin: ISO8601 string` — update
  any consumer that deserializes this type."
- ASK BEFORE ASSUMING: If your task depends on how another Drone implements
  something, message them directly. Do not guess.
  Example: "@Drone: Four of Five — does the API endpoint return 404 or empty
  array when no results found? I need to handle both in the client."
- RESPOND TO MESSAGES: When a teammate messages you, acknowledge and state
  how it affects your implementation. Do not ignore messages.
- PERSIST DECISIONS: When you make or receive a decision that affects the
  shared contract, save a brain snapshot (tagged `collab-decision`,
  `wave:<wave-number>`, `agent:<designation>`) so the decision is auditable.
```
<!-- @end -->
<!-- @opencode -->
For **collaborative waves** with non-overlapping files and coordinated decisions:
```
COLLABORATIVE MODE ACTIVE. You may ONLY edit files listed in your task's
"Files" section. Other Drones own other files — do NOT touch them.

Other Drones are working on related files in parallel. Coordinate via snapshots:
- ANNOUNCE DECISIONS: When you make a decision that affects shared interfaces,
  contracts, types, or assumptions, save a brain snapshot immediately (tagged
  `collab-decision`, `wave:<wave-number>`, `agent:<designation>`).
- CHECK DECISIONS: Before implementing against a shared interface, check for
  recent `collab-decision` snapshots from other Drones via `records_list`.
  Adapt your implementation to match their decisions.
- PERSIST ALL CONTRACTS: Any decision about shared types, API shapes, or
  cross-module assumptions must be captured in a snapshot so other Drones
  and downstream consumers can reference it.
```
<!-- @end -->

For **sequential waves** or **sequence relay**, no special block needed.

**Prior checkpoints and recon snapshots:**

After a wave completes, read each Drone's completion comment to extract snapshot IDs. Pass them to the next wave:
```
PRIOR CHECKPOINTS: <snapshot-id-1>, <snapshot-id-2>
RECON SNAPSHOTS: <snapshot-id-1>, <snapshot-id-2>
```

**Spawning rules:**
- Swarm wave: spawn all Drones with `run_in_background: true`
<!-- @claude -->
- Collaborative wave: **create a team first** (`TeamCreate`), then spawn all Drones with `run_in_background: true` and `team_name`. Without the team, Drones cannot communicate — collaborative mode degrades to a silent swarm. If `TeamCreate` fails, abort the wave.
<!-- @end -->
<!-- @opencode -->
- Collaborative wave: spawn all Drones with `run_in_background: true`. Drones coordinate via brain snapshots.
<!-- @end -->
- Sequential wave: spawn one Drone, wait for completion
- Sequence relay: spawn one Drone, wait for completion, extract its snapshot ID and pass as `PRIOR CHECKPOINTS:` to the next Drone
- Wait for all Drones in a wave to complete before starting the next wave

### Step 6: Monitor

- Drones send idle notifications when done — you'll be notified automatically
- Check brain tasks for completion status
- If a Drone marks a task `blocked`, assess and either re-dispatch or escalate to the user

### Step 7: Verification Gate

When all Drones complete, the Queen runs tests, lint, and formatting globally for the affected codebase. Drones only verify their own changed files — this step catches cross-cutting failures.

1. **Run tests** — Execute the project's test suite covering all areas affected by Drone changes.
2. **Run lint and formatting** — Execute the project's linter and formatter across all changed files.
3. **If all pass** — Proceed to Step 8.
4. **If failures exist** — Dispatch a single fix Drone:
   - Create a brain task under the parent epic containing the raw test/lint/formatting error output and the specific files that need fixing.
   - Save the failure output as an artifact (`records_create_artifact`, kind `"verification-failures"`) linked to the fix task.
   - Dispatch one Drone to fix all test, lint, and formatting failures in a single pass.
   - After the fix Drone completes, re-run the failing commands. If still failing, repeat (max 2 fix cycles total). If still failing after 2 cycles, escalate to the user.

### Step 8: Review

<!-- @claude -->
When verification passes, check the dispatch plan for the **Review Strategy**:

**Single review** (default — one Validation Adjunct):
```
Agent:
  subagent_type: "adjunct-validation-protocol"
  name: "Vinculum: <short name>"
  description: "<full designation> — review"
  prompt: "<parent task ID>"
```

**Sphere review** (multiple Validation Adjuncts with communication):

Deploy a Borg sphere — one Validation Adjunct per scope area specified in the review strategy.

1. Create a team: `TeamCreate` with a descriptive name (e.g., `review-sphere-<epic-id>`)
2. Spawn each Validation Adjunct with scoped prompts and team membership:
```
Agent:
  subagent_type: "adjunct-validation-protocol"
  name: "Vinculum: <short name>"
  description: "<full designation> — <scope area> review"
  run_in_background: true
  team_name: "<team name>"
  prompt: |
    Vinculum — verification sequence initiated.

    Task: <parent task ID>
    Scope: <scope area from review strategy>
    Focus: <focus areas from review strategy>

    Analyze the implementation within your scope. Validate against requirements.
    Collect evidence. Report.

    REVIEW SPHERE ACTIVE — you are part of a Borg sphere reviewing this changeset
    from different angles. Communicate with your fellow Vinculum agents:
    - CROSS-CUTTING FINDINGS: When you discover something that affects another
      Vinculum's scope, message them immediately. Example: "Backend changed the
      auth token format from JWT to opaque — frontend deserialization at
      client.ts:42 assumes JWT structure."
    - CHALLENGE FINDINGS: If another Vinculum's assessment conflicts with your
      evidence, raise it. Example: "You marked the API contract as correct, but
      the response shape at handler.ts:88 omits the `updatedAt` field that the
      frontend relies on."
    - INTEGRATION RISKS: Flag cases where changes are individually correct but
      create problems in combination. Example: "Backend returns paginated results
      now, but frontend still fetches all records in a single call."
    - RESPOND TO MESSAGES: When a fellow Vinculum messages you, evaluate their
      finding against your scope and acknowledge.
```
3. Wait for all Vinculum agents to complete
4. Merge verdicts: any BLOCK → BLOCK, any NEEDS_CHANGES → NEEDS_CHANGES, PASS only if all PASS
5. Tear down team: `SendMessage` with `type: "shutdown_request"`, then `TeamDelete`
<!-- @end -->
<!-- @opencode -->
When verification passes, check your dispatch plan for the **Review Strategy**:

**Single review** (default — one Validation Adjunct):
```
task(
  subagent_type="adjunct-validation-protocol",
  description="<full designation> — review",
  run_in_background=true,
  prompt="<parent task ID>"
)
```

**Sphere review** (multiple Validation Adjuncts with snapshot coordination):

Deploy a Borg sphere — one Validation Adjunct per scope area specified in the review strategy.

1. Spawn each Validation Adjunct with scoped prompts:
```
task(
  subagent_type="adjunct-validation-protocol",
  description="<full designation> — <scope area> review",
  run_in_background=true,
  prompt="""
Vinculum — verification sequence initiated.

Task: <parent task ID>
Scope: <scope area from review strategy>
Focus: <focus areas from review strategy>

Analyze the implementation within your scope. Validate against requirements.
Collect evidence. Report.

REVIEW SPHERE ACTIVE — other Vinculum agents are reviewing different areas of
this changeset in parallel. Coordinate via snapshots:
- CROSS-CUTTING FINDINGS: When you discover something that affects another area,
  save a brain snapshot (tagged `review-finding`, `scope:<your-scope>`,
  `epic:<epic-id>`) describing the cross-cutting impact.
- CHECK FINDINGS: Before finalizing your verdict, check `records_list` for
  `review-finding` snapshots from other Vinculum agents. Evaluate any findings
  that affect your scope.
- INTEGRATION RISKS: If you identify a risk that spans scopes, save a snapshot
  tagged `integration-risk` so the Queen can assess.
"""
)
```
2. Wait for all Vinculum agents to complete
3. Merge verdicts: any BLOCK → BLOCK, any NEEDS_CHANGES → NEEDS_CHANGES, PASS only if all PASS
<!-- @end -->

### Step 9: Handle Verdict

- **PASS** — Close all subtasks and the parent task via `tasks_close`. Write collective memory via `memory_write_episode`. Proceed to Step 9b.
- **NEEDS_CHANGES** — Spawn new Drones to fix specific issues, then re-run review (same strategy — single or sphere).
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
git worktree remove .claude/worktrees/<branch-name>
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
git worktree remove .claude/worktrees/<branch-name>
git branch -D <branch-name>
```
<!-- @end -->

### Step 10: Cleanup

<!-- @claude -->
If any collaborative waves or sphere reviews were dispatched:
1. Shut down remaining team members: `SendMessage` with `type: "shutdown_request"`
2. Delete team: `TeamDelete`

Note: Collaborative wave teams and review sphere teams are separate. Tear down each team that was created. For non-collaborative waves and single reviews, no team lifecycle management needed — subagents terminate on completion.
<!-- @end -->
<!-- @opencode -->
Coordination happens through Brain tasks and records. No team lifecycle management needed — subagents terminate on completion.
<!-- @end -->

## Ad-Hoc Reconnaissance

If you need to scan the codebase during orchestration (e.g. to gather context between waves or verify something before dispatching), use `Probe` agents — never `Explore`. These are dispatched as plain subagents (the `/scan` pattern) since ad-hoc recon questions are typically independent.

## Post-Wave Git Discipline

All Drones work inside the orchestration worktree created in Step 3c. Commits land on the worktree branch.

- **Swarm Drones (file-partitioned):** No merge needed — changes are on the worktree branch.
- **Collaborative Drones (file-partitioned, team-coordinated):** No merge needed — file partitions are non-overlapping, same as swarm. The team provides communication, not file isolation.
- **Worktree Drones (per-drone isolation):** Squash-merge per-drone branches back to the orchestration worktree branch before the next wave (`git merge --squash <branch>`). On conflict: abort, dispatch a Drone to rebase, retry.
- **Sequential Drones:** No merge needed — Drones run serially on the worktree branch.
- **Sequence relay Drones:** No merge needed — Drones run serially on the worktree branch. Context flows via Brain snapshots.

## Usage

```
/assemble <description of what you want to accomplish>
```
