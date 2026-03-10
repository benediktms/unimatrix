---
name: plan
description: Plan, execute, and review a complex task end-to-end using the Queen agent.
---

# /plan

Invoke the **queen** agent to handle a complex task end-to-end: plan it, create brain tasks, dispatch drones, review the work, and close the epic.

## Behavior

1. Delegate to the `queen` agent with the user's request
2. The queen will:
   - Research the codebase and produce a plan
   - Present the plan for user approval (plan mode)
   - After approval, create brain tasks with dependencies
   - Dispatch drone agents to execute each step
   - Trigger vinculum review when all steps complete
   - Close the epic on PASS

## Usage

```
/plan <description of what you want to accomplish>
```
