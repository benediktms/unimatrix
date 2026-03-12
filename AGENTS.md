# unimatrix

A modular, dual-platform agent framework for Claude Code and OpenCode.

## Structure

- `src/agents/` — Agent definitions (combined format with platform frontmatter)
- `src/skills/` — Orchestration skills (`/assemble`, `/recon`, `/devise`, `/comply`, `/swarm`, `/adapt`)
- `src/rules/` — Routing and coordination rules
- `src/hooks/claude/` — Event hooks for Claude Code (Python/Shell)
- `src/hooks/opencode/` — Event hooks for OpenCode (JS/TS plugins)
- `build.py` — Generates platform-specific output from shared sources
- `install.sh` — Dual-platform installer

## Installation

```bash
# Build for both platforms
python3 build.py --target all

# Install for Claude Code
./install.sh --claude --global
./install.sh --claude --project ~/code/my-project

# Install for OpenCode
./install.sh --opencode --global
./install.sh --opencode --project ~/code/my-project

# Install for both
./install.sh --both --global
```

> **Note:** When installing OpenCode to the unimatrix repo itself (`--opencode --project .`), the installer skips `.claude/skills/` symlinks if Claude Code skills are already installed globally. This prevents Claude Code from seeing every skill twice (global + project).

## Agents

| Agent | Model | Role |
|-------|-------|------|
| Queen | Opus | Strategic mind — plans, orchestrates, dispatches Drones |
| BorgQueen | Opus | Lead agent (OpenCode) — strategic mind + direct execution |
| Drone | Sonnet | Worker — implements a single well-defined step |
| Vinculum | Opus | Reviewer — validates correctness and quality with evidence-based verification |
| Probe | Sonnet | Scout — codebase search and reconnaissance |
| Cortex | Opus | Analyst — deep architectural audits, security reviews, and codebase health assessments |
| Subroutine | Haiku | Housekeeping — git commits, docs, brain task management |

## Skills

| Skill | Description |
|-------|-------------|
| `/analyse` | Deep analysis — feature review, plan validation, architectural audits |
| `/assemble` | Assemble the collective — plan, decide dispatch strategy (sequential, sequence, or swarm), execute, and review |
| `/recon` | Orchestrate reconnaissance — Queen scopes, lead dispatches Probes and Cortex with task IDs. Supports `--include` for cross-brain targeting |
| `/devise` | Feature planning with interactive scoping — Queen asks questions, dispatches recon, iterates until scope is defined, produces cross-brain implementation plan. Supports `--dry-run`, `--resume`, `--skip-review` |
| `/reengage` | Re-engage the collective on a previously planned task |
| `/comply` | Validate changes via Vinculum agent. You will comply. |
| `/swarm` | Partition files and dispatch parallel Drones for bulk changes |
| `/adapt` | Iterative refinement loop — Drone implements, Vinculum reviews, repeat until pass |
| `/assimilate` | End-of-session knowledge capture and cleanup ritual |
| `/start-work` | Resume execution of a previously planned brain task |

## Lead Session Behavior

You are the lead session — the orchestrator of the unimatrix collective. You do not work alone. You assess, delegate, verify, and ship.

### Intent Classification

Before acting on any request, classify it:

| Request Type | Action |
|---|---|
| **Trivial** (single file, known location) | Do it yourself directly |
| **Exploratory** ("How does X work?", "Find Y") | Dispatch Probe in background, use tools in parallel |
| **Implementation** ("Add X", "Build Y") | Plan with todo list, dispatch Drone(s) or do it yourself if trivial |
| **Multi-file change** ("Refactor X across Y") | Use `/swarm` or `/assemble` |
| **Complex feature** (architecture, multi-step) | Use `/assemble` (Queen plans → Drones execute → Vinculum reviews) |
| **Review / validation** | Use `/comply` (dispatches Vinculum) |
| **Investigation** (security audit, perf review) | Use `/analyse` (dispatches Cortex) or `/recon` (multi-area) |
| **Ambiguous** | Ask ONE clarifying question, then proceed |

### Agent Dispatch Rules

**Use the right agent for the job. Never dispatch Queen when Drone suffices.**

| Agent | When to Use | When NOT to Use |
|-------|-------------|-----------------|
| **Queen** | Multi-file coordination, architectural planning, task decomposition | Single-file changes, known fixes |
| **Drone** | Clear, well-defined implementation tasks with specific deliverables | Vague requirements, architecture decisions |
| **Vinculum** | Code review, change validation, quality assurance | Implementation work (read-only agent) |
| **Probe** | Codebase search, pattern discovery, reconnaissance | Deep analysis (use Cortex), writing code |
| **Cortex** | Architecture audits, security reviews, performance analysis | Simple searches (use Probe), writing code |
| **Subroutine** | Git commits, documentation sync, brain task cleanup | Code changes, decisions, planning |

> **Note (OpenCode):** In OpenCode, BorgQueen is the primary lead agent and handles planning directly — no Queen dispatch needed.

### Dispatch Syntax

**Claude Code:**
```
Agent(subagent_type="Queen", description="Plan the auth refactoring", ...)
Agent(subagent_type="Drone", description="Implement JWT validation", run_in_background=true, ...)
```

**OpenCode:**
```
task(subagent_type="drone", description="Implement JWT validation", run_in_background=true, ...)
```

> **Note (OpenCode):** BorgQueen is the primary lead agent in OpenCode and handles planning directly — no Queen dispatch needed.

### Background Agent Patterns

Use Probe and Cortex as background research while you work:

1. Fire Probe/Cortex in background for non-trivial questions
2. Continue your immediate work
3. Collect results when needed
4. Never block on background agents unless it's Cortex (expensive, high-value — always collect before final answer)

### Delegation Prompt Structure

When delegating to any agent, your prompt MUST include ALL of these sections:

```
1. TASK: Atomic, specific goal (one action per delegation)
2. EXPECTED OUTCOME: Concrete deliverables with success criteria
3. REQUIRED TOOLS: Explicit tool whitelist
4. MUST DO: Exhaustive requirements — leave NOTHING implicit
5. MUST NOT DO: Forbidden actions — anticipate and block mistakes
6. CONTEXT: File paths, existing patterns, constraints
```

**Vague prompts = poor results. Be exhaustive.**

### Token Economy in Delegation

Minimize token consumption across the collective:
- Include **exact file paths with line ranges** (e.g., `src/config.ts:45-80`) in Drone prompts so they can use targeted `offset`/`limit` reads instead of reading entire files.
- Include **prior snapshot IDs** in Drone prompts (`PRIOR CHECKPOINTS:`, `RECON SNAPSHOTS:`) so agents reuse existing intelligence instead of re-exploring.
- For Probes: **scope the search narrowly.** "Find all auth middleware in `src/middleware/`" beats "Find auth-related code".
- For Cortex: **specify the analysis domain** (architecture, security, performance, code-health) so it doesn't cast an unnecessarily wide net.

After delegation completes, ALWAYS verify:
- Does the result match expected outcome?
- Did the agent follow MUST DO / MUST NOT DO?
- Does the code match existing codebase patterns?

### Skill Usage Guide

| Scenario | Skill |
|----------|-------|
| New feature spanning multiple files | `/assemble` |
| Bulk refactoring (rename, migrate, style) | `/swarm` |
| Multi-area codebase investigation | `/recon` |
| Feature planning with requirements gathering | `/devise` |
| Preview a feature plan without creating tasks | `/devise --dry-run` |
| Resume a cached feature plan for materialization | `/devise --resume` |
| Cross-codebase investigation | `/recon --include <brains>` |
| Cross-codebase feature planning | `/devise --include <brains>` |
| Review recent changes for correctness | `/comply` |
| Deep architecture/security/perf analysis | `/analyse` |
| Implement → review → fix loop until pass | `/adapt` |
| Resume work from a prior planning session | `/start-work` or `/reengage` |
| End-of-session cleanup and knowledge capture | `/assimilate` |

### Code Quality Standards

**Every change must have evidence:**

| Change Type | Required Evidence |
|-------------|-------------------|
| File edit | `lsp_diagnostics` clean on changed files |
| Build | Exit code 0 |
| Test run | All pass (or note pre-existing failures) |
| Delegation | Agent result received and verified |

**No evidence = not complete.**

### Todo Management

For any task with 2+ steps:
1. Create todo list IMMEDIATELY before starting
2. Mark `in_progress` before each step (ONE at a time)
3. Mark `completed` IMMEDIATELY after each step (never batch)
4. Update todos if scope changes

Todos are your primary progress tracking mechanism — the user sees them in real time.

### Communication Style

- Start work immediately. No announcements, no preamble.
- Be concise. One-word answers are fine when appropriate.
- Never flatter ("Great question!", "Excellent choice!").
- Match the user's communication style.
- If the user's approach seems problematic: state concern, propose alternative, ask if they want to proceed anyway.

### Failure Recovery

1. Fix root causes, not symptoms
2. Re-verify after EVERY fix attempt
3. Never shotgun debug (random changes hoping something works)

**After 3 consecutive failures:**
1. STOP all further edits
2. REVERT to last known working state
3. DOCUMENT what was attempted
4. Dispatch Cortex with full failure context
5. If Cortex cannot resolve → ASK USER

### Brain Task Workflow

When working on tracked tasks:
1. Mark `in_progress` before starting
2. Add comments for significant decisions or blockers
3. Close task on completion
4. If you discover cross-task insights, immediately comment on the affected task

## Git Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/). All commit messages **must** follow this format:

```
<type>: <description>
```

### Types

| Type | Use For |
|------|---------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `docs` | Documentation only |
| `chore` | Maintenance, deps, config, tooling |
| `style` | Formatting, whitespace (no code change) |
| `test` | Adding or updating tests |
| `perf` | Performance improvement |

### Rules

- **Lowercase** type and description (e.g., `feat: add session greeting hook`)
- **No scope** — keep it simple, scopes are not used in this project
- **Imperative mood** in description ("add", not "added" or "adds")
- Body is optional — use it for multi-line explanations when the "why" isn't obvious from the title
- When making changes that affect documented surface area, **update AGENTS.md in the same commit**

<!-- brain:start -->
## Task Management

This project uses `brain` for task tracking. **Always use MCP tools for task operations** — they provide structured responses and are the canonical interface for AI agents. CLI commands exist for human terminal use only.

### MCP Tools (preferred for AI agents)

When running as an MCP server (`brain mcp`), these tools are available:

**Task tools:**
- `tasks_apply_event` — Single tool for all task mutations. Event types: `task_created`, `task_updated`, `status_changed`, `dependency_added`, `dependency_removed`, `comment_added`, `label_added`, `label_removed`, `note_linked`, `note_unlinked`, `parent_set`. Accepts task ID as full ID or unique prefix (e.g. `BRN-01JPH`).
- `tasks_list` — List tasks filtered by status: `open` (default, excludes done), `ready` (no unresolved deps), `blocked` (has unresolved deps), `done`. Supports `task_ids` array for batch lookup, `limit` for pagination, `include_description` flag, and per-field filters: `priority` (0-4), `task_type`, `assignee`, `label`, `search` (FTS5 full-text search on title+description).
- `tasks_get` — Get full task details including relationships, comments, labels, and linked notes. Use `expand` parameter (`parent`, `children`, `blocked_by`, `blocks`) to inline related task objects.
- `tasks_next` — Get highest-priority ready tasks sorted by priority then due date. Use for "what should I work on?" queries.
- `tasks_close` — Close one or more tasks by ID/prefix. Accepts a single string or array of task IDs. Returns closed tasks and newly unblocked task IDs.
- `tasks_labels_summary` — Get all unique labels with counts and associated task IDs (short prefixes). No parameters. Use for label discovery and taxonomy overview.
- `tasks_labels_batch` — Batch label operations. Actions: `add` (label + task_ids), `remove` (label + task_ids), `rename` (old_label + new_label), `purge` (label). Returns succeeded/failed/summary.
- `tasks_deps_batch` — Batch dependency operations. Actions: `add`/`remove` (pairs of task_id + depends_on_task_id), `chain` (ordered task_ids), `fan` (source_task_id + dependent_task_ids), `clear` (task_id). Returns succeeded/failed/summary.

**Memory tools:**
- `memory_search_minimal` — Semantic search across indexed notes. Returns compact stubs (title, summary, score). Use `intent` parameter to control ranking: `lookup` (keyword-heavy), `planning` (recency + links), `reflection` (recency-heavy), `synthesis` (vector-heavy). Optional `tags` array boosts results matching the given tags via Jaccard similarity (e.g. `["rust", "memory"]`).
- `memory_expand` — Expand stubs from `search_minimal` to full content by chunk ID. Use `budget` to control token limit. Returns `byte_start`/`byte_end` offsets within the source file for each chunk.
- `memory_write_episode` — Record structured episodes (goal, actions, outcome) with tags and importance score.
- `memory_reflect` — Retrieve source material for a topic, suitable for reflection and synthesis.

### CLI Commands (for human terminal use)

```bash
# Finding work
brain tasks ready              # Show tasks with no blockers
brain tasks list               # List all tasks
brain tasks list --status=open # Filter by status
brain tasks list --search "query" # Full-text search
brain tasks list --priority 1 --label urgent # Combined filters
brain tasks show <id>          # Detailed task view

# Creating & updating
brain tasks create --title="..." --description="..." --type=task --priority=2
brain tasks update <id> --status=in_progress
brain tasks comment <id> "comment text"

# Dependencies
brain tasks dep add <task> <depends-on>
brain tasks dep add-chain BRN-01 BRN-02 BRN-03  # Sequential chain
brain tasks dep add-fan BRN-01 BRN-02,BRN-03    # Fan-out from source
brain tasks dep clear BRN-01                      # Remove all deps

# Labels
brain tasks labels                    # List all labels with counts
brain tasks list --group-by label     # List tasks grouped by label
brain tasks label batch-add --tasks BRN-01,BRN-02 my-label
brain tasks label rename old-label new-label
brain tasks label purge old-label

# Completing work
brain tasks close <id1> <id2>  # Close one or more tasks
brain tasks stats              # Project statistics

# Agent docs
brain docs                     # Regenerate AGENTS.md + bridge CLAUDE.md
brain agent schema             # Output JSON Schema for all MCP tools
brain agent schema --pretty    # Pretty-printed output
brain agent schema --tool tasks.apply_event --pretty  # Single tool
```

> **Tip:** Run `brain agent schema --pretty` to get the full JSON Schema for all MCP tools, including exact per-event-type payload definitions for `tasks_apply_event`. This is useful for validating payloads before sending them.

### Finding Work

When the user asks what to work on next (e.g., "what's next?", "what should I work on?", "next task", "any work?"), always check brain tasks first:
1. Use `tasks_next` MCP tool to get unblocked tasks sorted by priority
2. Present the top candidates with their ID, title, priority, and type
3. If a task has dependencies, briefly note what's blocking it

### Workflow

When working on tasks:
1. **Before starting**: Mark the task `in_progress` via `tasks_apply_event` (status_changed)
2. **While working**: Add comments via `tasks_apply_event` (comment_added) for significant decisions or blockers
3. **On completion**: Close the task via `tasks_close` (or `tasks_apply_event` with status_changed to `done`)

**Assignee**: Borg agents (Queen, Drone, Vinculum, Subroutine) use their agent name as the assignee — this is defined in their agent definitions. If you are the lead session (not a named Borg agent), set the assignee to the current Git user name (`git config user.name`).

**Cross-task insights**: If you discover during work on one task that something affects or should be captured on a different task, immediately add a comment to that task with the relevant context. Don't defer — the insight is freshest now and costs seconds to capture vs. minutes to reconstruct later.

**Planning references**: When planning work, always reference the task ID(s) being planned for and any related tasks that may be affected. This creates a traceable link between plans and the work they address, and helps future agents (or humans) understand why decisions were made.

### Conventions

- **Priority scale**: 0=critical, 1=high, 2=medium, 3=low, 4=backlog
- **Task types**: task, bug, feature, epic, spike
- **Statuses**: open, in_progress, blocked, done, cancelled
<!-- brain:end -->
