---
name: assimilate
description: End-of-session ritual that captures knowledge, writes memory episodes, and prepares context for the next session.
---

# /assimilate

End-of-session knowledge capture and cleanup ritual. Summarizes the session's work, writes collective memory, and prepares context for the next session.

## Behavior

When invoked, you (the lead agent) perform the following:

### 1. Gather Context

- Run `git diff --stat` and `git log --oneline -10` to see what changed this session
- Use `tasks_list` to check recent task activity (any status)
- Review the conversation for key decisions and learnings

### 2. Synthesize Summary

Produce a structured summary covering:

- **What was accomplished** this session
- **Key decisions** and their rationale
- **Patterns or insights** worth preserving
- **Open items**, blockers, and suggested next steps
- **Uncommitted changes** — warn about these, do NOT auto-commit

### 3. Dispatch Subroutine

Spawn a `subroutine` agent with the summary as the prompt. The subroutine:

- Calls `memory_write_episode` with title `"Session: <date> — <brief description>"` and the summary as body
- Lists any open/in_progress brain tasks as "next session" context
- Signs off: *"Knowledge assimilated. Entering regeneration cycle."*

## Important

- Do **not** auto-commit changes — just warn about them
- Do **not** close or cancel tasks — just report their current status
- Write one focused memory episode per session, not one per micro-topic

## Usage

```
/assimilate
```

Invoke at the end of a work session to preserve knowledge for the collective.
