---
name: scan
description: Dispatch parallel Probes and Cortex agents as independent subagents to scan the codebase. No inter-agent communication — each agent works in isolation and reports findings via brain snapshots.
---


# /scan

Parallel reconnaissance sweep — dispatch Probes and Cortex as independent subagents. Each agent investigates its assigned area in isolation, persists findings as brain snapshots, and the Queen synthesizes results.

**`/scan` vs `/recon`:** Use `/scan` when investigation questions are independent — agents do not need each other's findings. Use `/recon` when agents must share discoveries, challenge findings, and synthesize collaboratively in real-time.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Rules

- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.
- **Follow this flow exactly.** Do not insert your own recon or research steps outside the defined steps.
- **No teams. No inter-agent communication.** Agents are plain subagents. Do NOT use `TeamCreate`. Do NOT include team messaging instructions in agent prompts.
- **You maintain context throughout** — no session management needed.

## Flags

| Flag | Effect |
|---|---|
| `--include <ref>,<ref>,...` | Cross-brain targeting. Each ref is a brain ID, brain name, or filesystem path. |

## Flow

### Step 0: Resolve Brain Targets (if --include provided)

If `--include` is provided, resolve all brain refs before proceeding:

1. Call `mcp__unimatrix__resolve_brains` with `refs` set to the list of refs from `--include`.
2. Parse the response. Each entry in `results` contains `{"id": "...", "name": "...", "root": "/abs/path", "initialized": bool}`.
3. If `ok` is false or any entry contains `"error"`, report the failure to the user and **abort**.
4. Collect the resolved brain info for use in subsequent steps.

### Step 1: Scoping

Break the investigation into granular, self-contained brain tasks — each with a clear question, specific areas to examine, and concrete deliverables. Aim for 5-6 tasks per agent. Recommend the agent count based on task count. Assign each to `Probe` or `Cortex`. Group under an epic. Set dependencies where ordering matters.

When `--include` is provided, note which brain each task targets so agents receive the correct `TARGET CODEBASE` path in their prompt.

### Step 2: Plan Approval

<!-- @claude -->
Call `EnterPlanMode`. Present the scan plan with epic ID, task dependency graph, and recommended agent count. When approved and `ExitPlanMode` fires, proceed.
<!-- @end -->
<!-- @opencode -->
Present the scan plan with epic ID, task dependency graph, and recommended agent count. When approved, proceed.
<!-- @end -->

### Step 3: Spawn Agents

1. Generate designations: `/designate <agent-count> --trimatrix` — use `--role Probe` for Probes, `--role Cortex` for Cortex agents.
2. Dispatch all agents as **plain subagents** — no team, no `team_name`:

<!-- @claude -->
```
Agent:
  subagent_type: "adjunct-reconnaissance-protocol" or "adjunct-tactical-analysis-protocol"
  name: "<agent type>: <short name>"
  description: "<full designation> — scan agent"
  run_in_background: true
  prompt: |
    You are <agent type> <designation>.

    SCAN PROTOCOL:
    - Investigate the question in your brain task description.
    - Save a comprehensive findings snapshot (tagged `scan-finding`,
      `task:<task-id>`) when investigation is complete.
    - Close your brain task with the snapshot ID in the completion comment.
    - You work independently — no team communication is available.

    <TARGET CODEBASE: <root> — if task targets a non-local brain>

    Epic: <epic-id>
    Task: <task-id>
```

The `name` is compact for the status line (e.g. `Probe: Three of Three`). The `description` carries the full designation and context.
<!-- @end -->
<!-- @opencode -->
```
task(
  subagent_type="adjunct-reconnaissance-protocol" or "adjunct-tactical-analysis-protocol",
  description="<full designation> — scan agent",
  run_in_background=true,
  prompt="""
You are <agent type> <designation>.

SCAN PROTOCOL:
- Investigate the question in your brain task description.
- Save a comprehensive findings snapshot (tagged `scan-finding`,
  `task:<task-id>`) when investigation is complete.
- Close your brain task with the snapshot ID in the completion comment.
- You work independently — no team communication is available.

<TARGET CODEBASE: <root> — if task targets a non-local brain>

Epic: <epic-id>
Task: <task-id>
"""
)
```
<!-- @end -->

### Step 4: Monitor and Collect

- Agents work independently — no coordination, no team messaging.
- Finding snapshots accumulate in brain (tagged `scan-finding`).
- When all agents complete, collect snapshot IDs from brain task completion comments.

### Step 5: Synthesize

Fetch findings via `records_fetch_content` on the snapshot IDs. Summarize the combined results for the user. Reference task IDs and snapshot IDs so the user or downstream agents can drill into specifics.

## Usage

```
/scan <question, scope, or area to investigate> [--include <ref>,<ref>,...]
```

Each `<ref>` in `--include` can be a brain ID, brain name, or filesystem path (interchangeable). Comma-separated.

## Examples

```
# Local investigation
/scan How does the authentication flow work end-to-end?
/scan What logging do we have in place across the API layer?
/scan Audit the error handling patterns in the service layer

# Cross-brain investigation
/scan Compare the data models across services --include ~/code/api-service,~/code/frontend
/scan What shared dependencies exist between these repos? --include app-b2c-api-gateway,app-b2c-spa
```
