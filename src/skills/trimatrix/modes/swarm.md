# Swarm Mode

## Coordination Protocol Override

Swarm mode does NOT use the `neural_link` MCP server. SKILL.md Protocol F
(which mandates `mcp__neural_link__room_open`/`room_close` for multi-adjunct
dispatches) does not apply here. Swarm coordinates via native Claude Code
primitives only:

- `TeamCreate` to bootstrap the team
- `Agent(team_name=...)` to spawn drones into the team
- `SendMessage` for cross-partition messages
- `TaskList` for shared task visibility
- `mcp__brain__memory_write_episode` (or `records_save_snapshot`) at swarm
  close to capture decisions / blockers / partition outcomes

The synthesis episode is the durable replacement for the room transcript a
neural_link close would otherwise produce.

---

## When Triggered

- Bulk refactoring, migrations, convention enforcement
- The same change applies independently to multiple file groups
- Partitions may surface cross-cutting concerns requiring inter-drone coordination

## Flags

- First positional argument: max adjunct count (default: 5, hard max: 5)
- `--scope "glob"` — explicit glob pattern to restrict file discovery

---

## Flow

### 1. Plan Partitions

Search memory (`memory_search_minimal`) for prior recon on the target area.
If file layout is unknown, dispatch a probe to enumerate candidates.

Partition files into logical groups by directory, module, or feature boundary.

Rules:

- Each group must be independently modifiable — no shared files across groups.
- Hard maximum: 5 partitions. If more exist, merge smallest groups.
- Apply `--scope` glob if provided to restrict candidates.

Create brain tasks: one parent epic, one subtask per partition.
All subtasks are independent — no dependencies set.
Each subtask description includes:
Goal / Files / Instructions / Verification (per task description format).

### 1b. Optional: Declare Explicit Subgraphs Per Partition

<step name="declare-explicit-subgraphs" optional="true">
  <when>
    Partitions are known up-front and expected to remain stable across runs.
    Skip otherwise — connected-component derivation is sufficient for ad-hoc swarms.
  </when>
  <action>Call `mcp__unimatrix__add_subgraph` for each partition before `compute_waves`.</action>
  <example tool="mcp__unimatrix__add_subgraph">
```json
{
  "slug": "auth-partition",
  "label": "Auth files — Drone Two of Five",
  "nodeIds": ["auth-impl", "auth-verify-compile"],
  "executor": "ADJUNCT",
  "tier": "T2",
  "completionPolicy": "ALL",
  "failurePolicy": "FAIL_FAST"
}
```
  </example>
  <stability-guarantee>
    Explicit subgraphs use the user-supplied slug as their stable ID. If a
    partition is later resized, the derived `auto-*` sibling IDs shift but
    the explicit subgraph's slug remains constant — checkpoint-based resume
    stays predictable across runs with differing file counts.
  </stability-guarantee>
  <reference path="src/skills/trimatrix/SUBGRAPHS.md"/>
</step>

### 2. Generate Designations

Use Designation Generation Protocol (Protocol A).
Generate one designation per partition drone plus one for the sentinel.

### 3. Create Team

Before dispatching any drone, create a Claude Code team:

```text
TeamCreate(team_name: "swarm-<scope>")
```

Where `<scope>` is a short slug from the target area (e.g., `swarm-auth-migration`).
Record the team name — all drone `Agent` calls use it.

### 4. Dispatch Borg Cube

Spawn one drone per partition. All `run_in_background: true`.
Pass `team_name` from Step 3.

```text
Agent(
  team_name: "swarm-<scope>",
  subagent_type: "Drone Protocol",
  prompt: <partition brief + coordination directives below>
)
```

**Include in every drone prompt:**

```text
FILE PARTITION ACTIVE.
Only touch files listed in your task's Files section.
Other drones are running in parallel.
Crossing file boundaries creates conflicts and is non-compliant.
Cross-partition needs go through SendMessage — do not edit
files outside your partition.

TEAM COORDINATION ACTIVE (team: swarm-<scope>):
- CROSS-CUTTING FINDINGS: Message teammates via SendMessage when
  findings affect their scope. Include your partition ID and the
  specific concern in the message body.
- CHALLENGE FINDINGS: If you discover a conflict with another
  drone's approach, raise it via SendMessage immediately.
- INTEGRATION RISKS: Flag problems that emerge from combining
  individually-correct changes.
- RESPOND TO MESSAGES: Acknowledge all teammate messages before
  proceeding past the point they concern.
```

Also include the drone's designation.
Do NOT include `NEURAL LINK ACTIVE` or `room_id` — swarm uses native team
`SendMessage` for coordination, not neural_link rooms (see Coordination
Protocol Override above).

### 5. Monitor

Wait for all drones to notify completion. Check brain tasks for blocked states.

Blocked drone → assess whether the partition can be re-dispatched or must be
skipped. Report to user if skipping.

### 6. Verification Gate

Use Protocol C (Verification Gate).
Run after all drones complete (or all non-blocked drones complete).

### 7. Review

Dispatch one sentinel with parent epic task ID. Scope: full swarm output.

### 8. Handle Verdict

- **PASS:** Proceed to synthesis (Step 9).
- **NEEDS_CHANGES:** Identify which partitions require fixes. Spawn targeted
  fix drones per affected partition. Re-run Verification Gate and Review.
- **BLOCK:** Escalate to user verbatim. Do not attempt autonomous resolution.

Verdict aggregation rule: any BLOCK overrides all; any NEEDS_CHANGES overrides
PASS; PASS only when all partitions pass.

### 9. Synthesis (Persistence)

After sentinel PASS, the lead writes a synthesis episode capturing the run.

Call `mcp__brain__memory_write_episode` with the following fields:

```text
summary: "Swarm run: <scope> — <N> partitions, <outcome>"
content: |
  ## Decisions
  <Architectural or implementation decisions reached during the run>

  ## Blockers Encountered
  <Any blocked partitions, the root cause, and resolution>

  ## Per-Partition Outcomes
  <Partition ID | Status | PR URL | Notes>

  ## Cross-Cutting Findings
  <Findings surfaced through SendMessage during drone coordination>
tags: ["swarm", "synthesis", "<scope>"]
```

If `memory_write_episode` is unavailable, fall back to
`mcp__brain__records_save_snapshot` with the same content as `text`,
tagged `["swarm-synthesis", "epic:<epic-id>"]`.

### 10. Team Teardown

After synthesis is saved:

1. Send shutdown notification to all team members:

```text
SendMessage({team_name: "swarm-<scope>", message: "Swarm complete. Stand down."})
```

1. Delete the team:

```text
TeamDelete(team_name: "swarm-<scope>")
```

1. Confirm all team members have received the shutdown notification before
   proceeding to Task Closure.

### 11. Task Closure

Use Protocol E (Task Closure). Call `close_node(nodeId)` for each completed
node after sentinel PASS, then close the epic via `tasks_close`.
Report completion with partition summary and synthesis snapshot ID.
