---
name: designate
description: Generate Borg-style designations for drones based on the number of subtasks being dispatched.
---

# /designate

Generate Borg-style designations (e.g., "Seven of Nine, Septenary Adjunct of Unimatrix Zero") for drones before dispatching them.

## Behavior

1. **Count drone subtasks** — Determine how many drones will be dispatched.
2. **Generate designations** — Run `python3 hooks/designate.py <N>` via Bash, where N is the drone count. Each line of output is one designation.
3. **Assign to drones** — When spawning each drone:
   - Prepend `"You are <designation>."` to the drone's prompt
   - Set the Agent tool's `description` field to: `"<designation> — <task summary>"`
4. The drone will adopt its designation in its opening message and task comments.

## Usage

Invoked by the Queen during Phase 3 (Execute) before dispatching drones. Can also be called manually:

```
/designate <N>
```
