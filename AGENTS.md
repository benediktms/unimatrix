# unimatrix

A modular, symlink-friendly agent framework for Claude Code.

## Structure

- `agents/` — Agent definitions (markdown + YAML frontmatter)
- `skills/` — Slash command skills (`/plan`, `/start-work`, `/review`)
- `rules/` — Routing and coordination rules
- `hooks/` — Shell scripts for automation (future)
- `install.sh` — Symlink installer (global or per-project)

## Installation

```bash
# Global (all projects)
./install.sh --global

# Per-project
./install.sh --project ~/code/my-project
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| queen | Opus | Strategic mind — plans, orchestrates, dispatches drones |
| drone | Sonnet | Worker — implements a single well-defined step |
| adjunct | Opus | Reviewer — validates correctness and quality |
| probe | Sonnet | Scout — codebase search and reconnaissance |
| subroutine | Haiku | Housekeeping — git commits, docs, brain task management |

## Skills

| Skill | Description |
|-------|-------------|
| `/plan` | End-to-end: plan, create tasks, dispatch drones, review |
| `/start-work` | Resume execution of a previously planned epic |
| `/review` | Validate changes via adjunct agent |
