# Architect Mode

Alias: architect

## When Triggered
- Significant architectural shifts proposed
- "Compare approaches for X", "evaluate architecture options"
- Feature-driven re-architecture
- User explicitly uses architect

---

## Flags

- `--execute` — After convergence, hand winning approach to plan-execute mode for implementation.

---

## Architecture Adversarial Protocol

Include verbatim in every analyst's spawn prompt:

```
ARCHITECTURE ADVERSARIAL PROTOCOL:
APPROACH: "<approach name>"
OBJECTIVE: Evaluate this architectural approach with rigor. You are an analyst, not an advocate.

EVALUATION DIMENSIONS (rate 1-5 with evidence):
- Complexity: How much accidental complexity does this introduce?
- Risk: What can go wrong? How badly?
- Performance: Runtime and build-time impact
- Maintainability: Long-term cost of ownership
- Effort: Implementation cost (time, lines changed, migration burden)

INVESTIGATION:
- Trace the approach through the existing codebase
- Identify integration points and friction surfaces
- Collect evidence as file:line citations
- Prototype critical paths if feasible within budget

ADVERSARIAL DUTY:
- Read all teammate messages
- If you find a weakness in another agent's approach, message them immediately
- If another approach is clearly superior in a dimension, acknowledge it
- Do not defend a flawed design — adapt your assessment

WHEN INFEASIBLE:
- Acknowledge: "Approach infeasible: <evidence>"
- Identify which dimensions fail and why
- Assist remaining viable approaches with comparative insights

COMMUNICATION:
- Share every significant finding via team message immediately
- Respond to all teammate messages
- Save evidence snapshots tagged: architect-evidence, approach:<N>, agent:<designation>

FINAL REPORT:
Save snapshot tagged architect-final with:
- Approach name
- Verdict: VIABLE / RISKY / INFEASIBLE
- Dimension ratings (1-5 each with one-line justification)
- Key strengths
- Key weaknesses
- Notable interactions with teammates
```

---

## Flow

### Step 1: Generate Approaches
Budget: ~30 tool uses. Scan the relevant area — existing architecture, constraints, dependencies, prior art.
Generate 2–4 competing architectural approaches. Include the user's proposed approach if provided.
Create brain tasks: one epic + one subtask per approach (all independent, no chained dependencies).

### Step 1b: Present Approaches
Present approaches to user before spawning agents. User may approve, add, or remove entries.
Proceed only on explicit approval.

### Step 2: Create Team and Spawn Analysts
1. Use Designation Generation Protocol. Role: DESIGNATE for all analysts.
2. Create team: `TeamCreate(team_name: "architect-<epic-id>")` — **MANDATORY**. Abort if creation fails.
3. Build execution graph: `mcp__unimatrix__init` with `repos: []`, then `mcp__unimatrix__add_node` per subtask with `type: ANALYSIS`. No edges — single wave, all parallel.
4. `mcp__unimatrix__compute_waves` to validate.
5. Spawn one designate per approach into the team.
6. Each agent prompt includes: the Architecture Adversarial Protocol block above, the specific `APPROACH:` line, and the agent's brain task ID.
7. Dispatch all with `run_in_background: true`.

### Step 3: Monitor Analysis
Agents evaluate, communicate, and challenge each other autonomously.
Queen does NOT intervene unless an agent is stuck or unresponsive.

Unresponsive agent: sever link, mark task blocked, note which approaches remain under evaluation.

### Step 4: Convergence
Collect all snapshots tagged `architect-final` via `records_fetch_content`.
Synthesize tradeoff matrix:

```
| Dimension       | Approach A | Approach B | Approach C |
|-----------------|------------|------------|------------|
| Complexity      | 3          | 2          | 4          |
| Risk            | 2          | 4          | 1          |
| Performance     | 4          | 3          | 5          |
| Maintainability | 4          | 2          | 3          |
| Effort          | 3          | 5          | 2          |
| **Total**       | **16**     | **16**     | **15**     |
| Verdict         | VIABLE     | RISKY      | VIABLE     |
```

Recommendation with rationale. Confidence:
- HIGH — clear winner with margin of 3+ points and no INFEASIBLE/RISKY verdict
- MEDIUM — winner exists but margin is narrow or one dimension is weak
- LOW — no clear winner or multiple approaches rated RISKY/INFEASIBLE

Save architect brief as artifact: `kind: plan`, tags `["architect-brief"]`, `task_id: <epic-id>`.
Save tradeoff matrix as snapshot tagged `architect-evidence`.
Save final recommendation as snapshot tagged `architect-recommendation`.

### Step 5: Present Recommendation
Report tradeoff matrix, recommendation, and confidence level.
If `--execute` was not passed: stop here. Task Closure Protocol applies.

### Step 6: Execute (if --execute)
If confidence is LOW: ask user before proceeding. Do not auto-execute an inconclusive evaluation.

Hand winning approach to plan-execute mode:
- Pass architect brief as the directive
- The brief contains the winning approach, tradeoff context, and key constraints
- Plan-execute mode decomposes and implements from there

### Step 7: Cleanup
Shut down all team members. Delete team.
Confirm all brain tasks — subtasks and epic — are in terminal state before reporting completion.
