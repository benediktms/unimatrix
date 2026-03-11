---
name: designate
description: Generate Borg-style designations for agents based on the number of subtasks being dispatched.
---

# /designate

Generate Borg-style designations (e.g., "Seven of Nine, Septenary Tactical Adjunct of Unimatrix Zero") for agents before dispatching them.

## Behavior

1. **Count subtasks** — Determine how many agents will be dispatched.
2. **Generate designations** — Run `python3 hooks/designate.py <N> [--role Drone|Vinculum|Probe] [--trimatrix]` via Bash. Each line of output is one designation. Role determines the Borg functional title:
   - `Drone` → Tactical Adjunct
   - `Vinculum` → Auxiliary Processor
   - `Probe` → Adjunct
   - (default) → Adjunct
   - `--trimatrix` → Uses "Trimatrix \<random\>" instead of "Unimatrix Zero" (use for all spawned agents)
3. **Assign to agents** — When spawning each agent:
   - Set the Agent tool's `name` to the designation
   - Set `description` to: `"<designation> — <task summary>"`
4. The agent will adopt its designation in its opening message and task comments.

## Usage

Invoked by the lead during `/assemble` Step 2 before dispatching drones. Can also be called manually:

```
/designate <N>                              # Generic Adjunct titles (Unimatrix Zero)
/designate <N> --role Drone                 # Tactical Adjunct titles
/designate <N> --role Vinculum              # Auxiliary Processor titles
/designate <N> --role Drone --trimatrix     # Trimatrix instead of Unimatrix
/designate <N> --role Drone --swarm         # Legacy alias for --trimatrix
```
