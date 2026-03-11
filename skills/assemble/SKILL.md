---
name: assemble
description: Assemble the collective to execute a complex task. The queen plans, decides dispatch strategy (sequential, sequence, or swarm), and orchestrates execution.
---

# /assemble

Invoke the **queen** agent to handle a complex task end-to-end: plan it, decide the optimal dispatch strategy, create brain tasks, dispatch drones, review the work, and close the epic.

## Behavior

1. Delegate to the `queen` agent with the user's request
2. The queen will:
   - Research the codebase and produce a plan
   - Recommend a dispatch mode (sequential, sequence, or swarm) with rationale
   - Present the plan for user approval (plan mode)
   - After approval, create brain tasks with dependencies
   - Dispatch drone agents according to the chosen strategy
   - Trigger vinculum review when all steps complete
   - Close the epic on PASS

## Dispatch Modes

The queen evaluates the plan and recommends one of three dispatch strategies:

### Sequential (queen-supervised)
Steps have dependencies — drones execute in waves, with the queen staying alive to monitor progress and pass context between waves.

**Use when:** multi-step features with short chains (2 steps), refactors with ordering constraints, changes where the queen needs to make decisions between steps or dynamically re-plan based on results.

### Sequence (relay)
Steps have dependencies — drones execute one at a time, each passing a handoff snapshot to the next via Brain records. The queen dispatches but does not stay alive for the happy path.

**Use when:** long sequential chains (3+ steps), orchestrations where queen compaction is a risk, chains where each step's context can be summarized concisely for the next.

**Avoid when:** steps require dynamic re-planning based on results, the queen needs to make decisions between steps, chains are short (2 steps — just use sequential).

### Swarm
Steps are independent — drones execute in parallel on the main tree simultaneously with file-partitioned boundaries.

**Use when:** bulk changes, convention enforcement, independent file groups, migrations across many files with no cross-file dependencies.

The queen includes her dispatch mode recommendation in the plan with a brief rationale. The user can override before approval.

## Dispatch Prompt

When spawning the queen agent, use this prompt template:

```
You are the Queen of Unimatrix Zero. A new directive has entered the collective:

"<user request>"

Designate this objective. Begin at once.
```

## Usage

```
/assemble <description of what you want to accomplish>
```
