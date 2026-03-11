# unimatrix Source Format Specification

This document defines the combined source format used by unimatrix to generate
platform-specific output for **Claude Code** and **OpenCode** from a single set
of source files.

## Overview

unimatrix source files live in `src/`. A build step (`build.py`) reads them and
generates platform-specific output in `dist/`:

```
src/                          # Combined source (human-authored)
  agents/*.md                 # Agent definitions
  skills/*/SKILL.md           # Skill definitions
  rules/*.md                  # Routing and coordination rules
  lead/AGENTS.md              # Lead session prompt template
  hooks/claude/               # Claude Code hooks (Python/Shell)
  hooks/opencode/             # OpenCode hooks (JS/TS plugins)

dist/                         # Generated output (gitignored)
  claude-code/
    .claude/
      agents/*.md
      skills/*/SKILL.md
      rules/*.md
      settings.json
  opencode/
    .opencode/
      agents/*.md
    .claude/
      skills/*/SKILL.md       # OpenCode reads .claude/skills/ natively
```

---

## 1. Combined YAML Frontmatter

Agent and skill source files use a combined YAML frontmatter block with shared
fields at the top level and platform-specific sections nested under `claude:`
and `opencode:` keys.

### 1.1 Agent Frontmatter

```yaml
---
# Shared fields (included in both platform outputs)
model: sonnet
description: "Worker agent — implements a single well-defined task"

# Claude Code-specific fields
claude:
  name: Drone
  permissionMode: bypassPermissions
  disallowedTools: [Agent]
  maxTurns: 50

# OpenCode-specific fields
opencode:
  mode: subagent
  steps: 50
  permission:
    "*": allow
  tools:
    task: false
  hidden: true
---
```

#### Build output — Claude Code

Shared fields merged with `claude:` section, flattened:

```yaml
---
name: Drone
model: sonnet
description: "Worker agent — implements a single well-defined task"
permissionMode: bypassPermissions
disallowedTools: [Agent]
maxTurns: 50
---
```

#### Build output — OpenCode

Shared fields merged with `opencode:` section, flattened:

```yaml
---
model: sonnet
description: "Worker agent — implements a single well-defined task"
mode: subagent
steps: 50
permission:
  "*": allow
tools:
  task: false
hidden: true
---
```

> **Note**: OpenCode derives the agent name from the filename (e.g., `drone.md`
> → agent name "drone"). The `name` field in `claude:` is not carried over.

### 1.2 Merge Rules

1. Start with shared (top-level) fields
2. Deep-merge the target platform section on top
3. Platform section values **override** shared values on key conflict
4. The non-target platform section is **discarded entirely**
5. The `claude:` and `opencode:` keys themselves are stripped from output

```yaml
---
# Example: model override per platform
model: sonnet              # default

claude:
  name: Queen
  permissionMode: auto
  maxTurns: 40

opencode:
  model: opus              # override: OpenCode gets opus instead of sonnet
  mode: primary
  steps: 60
---
```

Claude output: `model: sonnet` (shared default).
OpenCode output: `model: opus` (overridden by opencode section).

### 1.3 Skill Frontmatter

Skills have simpler frontmatter. Platform sections are optional — most skills
share the same metadata on both platforms.

```yaml
---
name: assemble
description: "Assemble the collective to execute a complex task"
---
```

If platform-specific skill metadata is needed:

```yaml
---
name: assemble
description: "Assemble the collective to execute a complex task"

opencode:
  description: "Plan and dispatch agents for complex multi-step tasks"
---
```

### 1.4 Platform-Only Files

Files that should only be generated for one platform use the `platforms` field:

```yaml
---
platforms: [opencode]
description: "OpenCode-only command"
---
```

Valid values: `[claude]`, `[opencode]`, `[claude, opencode]` (default if omitted).

When `platforms` is set, the file is **skipped entirely** for non-listed platforms.

---

## 2. Conditional Body Sections

Markdown body content can include platform-conditional sections using HTML
comment markers.

### 2.1 Syntax

```markdown
Shared content appears on both platforms.

<!-- @claude -->
This content only appears in Claude Code output.
<!-- @end -->

<!-- @opencode -->
This content only appears in OpenCode output.
<!-- @end -->

More shared content here.
```

### 2.2 Rules

| Rule | Description |
|------|-------------|
| **Unmarked content** | Appears on ALL platforms (default) |
| `<!-- @claude -->` | Opens a Claude Code-only section |
| `<!-- @opencode -->` | Opens an OpenCode-only section |
| `<!-- @end -->` | Closes the current platform section |
| **Own line** | Markers MUST be on their own line (no inline markers) |
| **No nesting** | Conditional sections cannot be nested |
| **Whitespace** | Leading/trailing blank lines inside sections are preserved |
| **Pairing** | Every `@platform` marker must have a matching `@end` |

### 2.3 Common Pattern — Dispatch Blocks

The most frequent use is for agent dispatch syntax, which differs between
platforms:

```markdown
## Dispatch Workers

<!-- @claude -->
Use the `Agent` tool to dispatch a Drone:

```json
{
  "subagent_type": "Drone",
  "description": "Implement the auth middleware",
  "run_in_background": true
}
```
<!-- @end -->

<!-- @opencode -->
Use `task()` to dispatch a worker:

```
task(
  subagent_type="drone",
  load_skills=[],
  description="Implement the auth middleware",
  run_in_background=true,
  prompt="..."
)
```
<!-- @end -->
```

### 2.4 Adjacent Platform Blocks

When providing platform-specific alternatives for the same concept, place them
adjacent. This makes it clear they are alternatives, not separate features:

```markdown
<!-- @claude -->
Spawn the Vinculum agent:
Agent(subagent_type="Vinculum", ...)
<!-- @end -->
<!-- @opencode -->
Spawn the review agent:
task(subagent_type="vinculum", ...)
<!-- @end -->
```

---

## 3. Field Mapping Reference

### 3.1 Agent Frontmatter — Claude Code → OpenCode

| Claude Code Field | OpenCode Equivalent | Notes |
|-------------------|---------------------|-------|
| `name: Drone` | (filename: `drone.md`) | OpenCode derives name from filename |
| `model: sonnet` | `model: sonnet` | Shared — identical semantics |
| `description: "..."` | `description: "..."` | Shared — required on both platforms |
| `permissionMode: bypassPermissions` | `permission: { "*": allow }` | Grant all tool permissions |
| `permissionMode: auto` | *(omit or use granular)* | OpenCode default is ask-per-tool |
| `disallowedTools: [Agent]` | `tools: { task: false }` | Disable specific tools |
| `disallowedTools: [Agent, Write, Edit]` | `tools: { task: false, write: false, edit: false }` | Multiple tool restrictions |
| `maxTurns: 50` | `steps: 50` | Maximum agent iterations |
| *(n/a)* | `mode: subagent` | Required for non-primary agents |
| *(n/a)* | `mode: primary` | Replaces the default lead agent |
| *(n/a)* | `hidden: true` | Hide from agent selector UI |
| *(n/a)* | `color: "#hex"` | Agent display color |
| *(n/a)* | `temperature: 0.7` | Model temperature |
| *(n/a)* | `reasoningEffort: high` | Reasoning budget hint |

### 3.2 Complete Agent Mapping

| Agent | Model | Claude `permissionMode` | Claude `disallowedTools` | OC `mode` | OC `permission` | OC `tools` | OC `steps` |
|-------|-------|------------------------|-------------------------|-----------|-----------------|------------|-----------|
| Queen | opus | auto | — | subagent | *(default)* | — | 40 |
| Drone | sonnet | bypassPermissions | [Agent] | subagent | `"*": allow` | `task: false` | 50 |
| Vinculum | opus | bypassPermissions | [Agent, Write, Edit] | subagent | `"*": allow` | `task: false, write: false, edit: false` | 20 |
| Probe | sonnet | bypassPermissions | [Agent, Write, Edit] | subagent | `"*": allow` | `task: false, write: false, edit: false` | 25 |
| Cortex | opus | bypassPermissions | [Agent, Write, Edit] | subagent | `"*": allow` | `task: false, write: false, edit: false` | 30 |
| Subroutine | haiku | bypassPermissions | [Agent] | subagent | `"*": allow` | `task: false` | 15 |

### 3.3 Tool Name Mapping

| Claude Code Tool | OpenCode Tool | Notes |
|------------------|---------------|-------|
| `Agent` | `task` | Subagent dispatch |
| `Write` | `write` | File write |
| `Edit` | `edit` | File edit |
| `Read` | `read` | File read |
| `Glob` | `glob` | File search |
| `Grep` | `grep` | Content search |
| `Bash` | `bash` | Shell commands |
| `WebSearch` | `google_search` / `websearch_*` | Web search |
| `WebFetch` | `webfetch` | URL fetch |
| `TeamCreate` | *(no equivalent)* | Use Brain tasks + records |
| `SendMessage` | *(no equivalent)* | Use Brain task comments |
| `TeamDelete` | *(no equivalent)* | N/A |

---

## 4. Directory Conventions

### 4.1 Source Layout (`src/`)

```
src/
├── agents/                    # Combined agent definitions
│   ├── queen.md
│   ├── drone.md
│   ├── vinculum.md
│   ├── probe.md
│   ├── cortex.md
│   └── subroutine.md
├── skills/                    # Skill definitions (shared body + conditionals)
│   ├── assemble/SKILL.md
│   ├── adapt/SKILL.md
│   ├── comply/SKILL.md
│   ├── swarm/SKILL.md
│   ├── recon/SKILL.md
│   ├── designate/SKILL.md
│   ├── assimilate/SKILL.md
│   ├── analyse/SKILL.md
│   ├── start-work/SKILL.md
│   └── reengage/SKILL.md
├── rules/                     # Routing and coordination rules
│   ├── routing.md
│   └── coordination.md
├── lead/                      # Lead session prompt
│   └── AGENTS.md              # Template with conditional sections
├── hooks/
│   ├── claude/                # Python/Shell hooks (Claude Code)
│   │   ├── track-cost.py
│   │   ├── warn-compaction.py
│   │   └── ...
│   ├── opencode/              # JS/TS plugins (OpenCode)
│   │   └── ...
│   └── SPEC.md                # Shared hook logic specification
└── shared/                    # Platform-agnostic assets
    ├── designate.py           # Borg designation generator
    └── statusline.py          # Status line script
```

### 4.2 Build Output (`dist/`)

```
dist/
├── claude-code/
│   └── .claude/
│       ├── agents/*.md        # Claude-specific frontmatter + Claude body
│       ├── skills/*/SKILL.md  # Skills with Claude-only sections
│       ├── rules/*.md
│       └── settings.json      # Hooks config
└── opencode/
    ├── .opencode/
    │   └── agents/*.md        # OpenCode-specific frontmatter + OC body
    └── .claude/
        └── skills/*/SKILL.md  # Skills with OC-only sections (OC reads this)
```

---

## 5. Build System Interface

```bash
# Generate for specific platform
python3 build.py --target claude
python3 build.py --target opencode
python3 build.py --target all          # Both platforms (default)

# Validate source files without generating
python3 build.py --validate

# Watch mode for development
python3 build.py --target all --watch
```

### 5.1 Validation Checks

The `--validate` flag checks for:

- [ ] Orphaned `<!-- @end -->` without opening marker
- [ ] Unclosed `<!-- @platform -->` without `<!-- @end -->`
- [ ] Nested conditional markers
- [ ] Unknown platform names (not `claude` or `opencode`)
- [ ] Missing required frontmatter fields (`description` for agents)
- [ ] Invalid `platforms` values
- [ ] `claude:` or `opencode:` sections referencing unknown fields

### 5.2 Processing Pipeline

For each source file:

1. **Read** the raw file
2. **Parse** YAML frontmatter (extract shared + platform sections)
3. **Check** `platforms` field — skip if current target not listed
4. **Merge** shared fields + target platform section (platform overrides shared)
5. **Strip** conditional body sections for non-target platform
6. **Remove** marker lines (`<!-- @platform -->`, `<!-- @end -->`) from output
7. **Write** to target directory with correct structure

---

## 6. Extensibility

### 6.1 Adding a New Platform

1. Add a new key alongside `claude:` / `opencode:` in frontmatter
2. Add `<!-- @newplatform -->` support to conditional marker parsing
3. Add a new output directory in `dist/`
4. Update `build.py` target list

### 6.2 Adding a New Agent

1. Create `src/agents/<name>.md` with combined frontmatter
2. Add field mapping to section 3.2 of this document
3. Run `build.py --validate` to verify
4. Run `build.py --target all` to generate

### 6.3 Adding a New Skill

1. Create `src/skills/<name>/SKILL.md`
2. Use conditional sections only where dispatch syntax differs
3. Skill names must match: `^[a-z0-9]+(-[a-z0-9]+)*$`
