---
name: assemble
description: Assemble the collective to execute a complex task. The queen plans, decides dispatch strategy (sequential or swarm), and orchestrates execution.
---

# /assemble

Invoke the **queen** agent to handle a complex task end-to-end: plan it, decide the optimal dispatch strategy, create brain tasks, dispatch drones, review the work, and close the epic.

## Behavior

1. Delegate to the `queen` agent with the user's request
2. The queen will:
   - Research the codebase and produce a plan
   - Recommend a dispatch mode (sequential or swarm) with rationale
   - Present the plan for user approval (plan mode)
   - After approval, create brain tasks with dependencies
   - Dispatch drone agents according to the chosen strategy
   - Trigger vinculum review when all steps complete
   - Close the epic on PASS

## Dispatch Modes

The queen evaluates the plan and recommends one of two dispatch strategies:

### Sequential
Steps have dependencies — drones execute in waves, each waiting for prior steps to complete.

**Use when:** multi-step features, refactors with ordering constraints, changes where later steps depend on earlier outputs.

### Swarm
Steps are independent — drones execute in parallel worktrees simultaneously.

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
