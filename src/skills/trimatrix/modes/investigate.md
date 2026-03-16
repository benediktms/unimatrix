# Investigate Mode

Aliases: /recon, /scan, /analyse

## When Triggered
- "How does X work", "find Y", "where is Z"
- Architectural questions, codebase exploration
- Security, performance, or health audits
- User explicitly uses /recon, /scan, or /analyse

---

## Sub-Mode Selection

| Sub-Mode | When | Formation | Team? |
|---|---|---|---|
| Collaborative | Questions are interconnected; agents benefit from sharing findings | Borg sphere | YES (mandatory) |
| Independent | Questions are self-contained; no cross-dependencies | Adjunct cluster | NO |
| Deep | Single focused analysis question | Single adjunct | NO |

Selection rules:
- If one agent's findings would change another's investigation → **collaborative**
- If questions can be answered independently → **independent**
- If a single deep analysis suffices → **deep**
- `/recon` alias → collaborative
- `/scan` alias → independent
- `/analyse` alias → deep

---

## Flags

- `--include <ref,...>` — Cross-brain targeting. Applies to all sub-modes. Call `resolve_brains` before dispatch.
- `--plan` — Feature planning mode: iterative scoping → plan → materialization. Collaborative sub-mode only.
- `--dry-run` — With `--plan`: produce and cache plan, skip materialization.
- `--resume [<artifact-id>]` — With `--plan`: load cached plan artifact, resume from materialization.
- `--skip-review` — With `--plan`: skip Tactical Analysis plan review.

---

## Flow: Collaborative Sub-Mode (Borg Sphere)

### Step 0: Resolve Brain Targets (if --include)
Call `resolve_brains`. Abort on failure. Assign species designations per Personality Protocol.

### Step 0b: Resume Cached Plan (if --plan --resume)
Fetch plan artifact by ID or via `records_list` with tag `recon-plan`. Present to user. On confirmation, skip to materialization.

### Step 1: Scoping

**Without --plan:** Decompose the investigation into 5–6 discrete questions. Assign each to a Reconnaissance adjunct (structure/location) or TacticalAnalysis adjunct (depth/judgment). Group under an epic. Set dependencies where one finding gates another. Produce a recon dispatch plan.

**With --plan (iterative scoping loop, max 5 iterations):**
Each iteration returns one of:
- `QUESTIONS_FOR_USER` → present to user, collect answers, continue
- `RECON_NEEDED` → dispatch recon adjuncts, collect findings, continue
- `SCOPE_COMPLETE` → break loop, proceed to feature plan

### Step 2: Plan Approval (without --plan)
Present recon dispatch plan to user. Wait for explicit approval before spawning agents.

### Step 3: Create Team and Spawn Agents
1. Use Designation Generation Protocol. Role: Reconnaissance or TacticalAnalysis per task.
2. Create team: `TeamCreate(team_name: "recon-<epic-id>")` — **MANDATORY**. Abort if creation fails.
3. Spawn all agents into team with Agent Communication Protocol included in each prompt.
4. Agents self-claim their brain tasks via `tasks_apply_event`.
5. For cross-brain tasks, include `TARGET CODEBASE: <path>` in agent prompt.
6. Dispatch all agents with `run_in_background: true`.

### Step 4: Monitor and Collect
Agents work through the dependency graph. Each saves a snapshot tagged `recon-finding` on completion. Queen does not intervene unless an agent is stuck or blocked.

Blocked agent: assess root cause, re-dispatch with clarification, or escalate to user. Do not retry with identical prompt.

### Step 5: Synthesize
Fetch completion snapshots via `records_fetch_content`. Summarize combined findings. Reference task IDs and snapshot IDs. Highlight unresolved disagreements from any `recon-challenge` snapshots.

### Step 6: Cleanup
Shut down all team members. Delete team. Confirm all brain tasks are in terminal state.

---

## Flow: Collaborative with --plan (Feature Planning)

After `SCOPE_COMPLETE`:

1. Produce implementation plan (same format as Plan-Execute Mode Step 3).
2. Cache plan as brain artifact: `kind: plan`, tags `["recon-plan"]`, `task_id: <epic-id>`.
3. If `--dry-run`: present plan to user, stop here.
4. Materialize into brain tasks via Plan Materialization Protocol.
5. Unless `--skip-review`: dispatch single TacticalAnalysis adjunct to review the plan. Verdict: APPROVE / REVISE / REJECT.
   - REVISE → incorporate feedback, re-present plan, re-review
   - REJECT → escalate to user verbatim
6. Present final plan to user for approval.
7. Shut down all teams. Confirm task state.

On resume (from `--resume`), skip steps 1–6, load cached artifact, proceed from step 4.

---

## Flow: Independent Sub-Mode (Adjunct Cluster)

### Step 0: Resolve Brain Targets (if --include)
Call `resolve_brains`. Abort on failure.

### Step 1: Scoping
Decompose investigation into self-contained questions. Each must be answerable without knowledge of other answers. Create brain tasks (epic + subtasks, all independent — no chained dependencies).

### Step 2: Plan Approval
Present scan plan to user. Wait for approval.

### Step 3: Spawn Agents
Use Designation Generation Protocol. Dispatch all agents as **plain subagents — no team, no `team_name`**.
Include in each prompt:
```
SCAN PROTOCOL: Investigate your assigned question independently.
Save findings as a snapshot (tagged scan-finding). Close your task on completion.
Do not wait for or communicate with other agents.
```
Dispatch all with `run_in_background: true`.

### Step 4: Monitor and Collect
Agents work independently. No inter-agent communication expected.

### Step 5: Synthesize
Fetch all `scan-finding` snapshots. Summarize. Present findings with source task IDs.

---

## Flow: Deep Sub-Mode (Single Adjunct)

Single TacticalAnalysis adjunct dispatch:
1. Use Designation Generation Protocol. Role: TacticalAnalysis.
2. Dispatch adjunct with the user's question as directive.
3. Wait for completion.
4. Present findings directly — no synthesis layer needed.

No team. No epic. One task, one adjunct, one report.
