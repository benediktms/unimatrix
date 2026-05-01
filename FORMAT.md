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
  skills/*/SKILL.md           # Skill definitions (trimatrix + named formations)
  rules/*.md                  # Routing, personality, token-economy, error-taxonomy
  hooks/claude/               # Claude Code hooks (Python/Shell)
  hooks/opencode/             # OpenCode hooks (JS/TS plugins)
  themes/*.json               # OpenCode TUI themes
  tui/tui.json                # OpenCode TUI configuration
  shared/                     # Platform-agnostic assets (statusline)

dist/                         # Generated output (gitignored)
  claude-code/
    .claude/
      agents/*.md
      skills/*/                # Each skill directory copied whole
      rules/*.md
      settings.json
  opencode/
    .opencode/
      agents/*.md
      plugins/*.ts             # Compiled OpenCode hook plugins
    .claude/
      skills/*/                # OpenCode reads .claude/skills/ natively
    themes/*.json
    tui.json
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

> **Note**: OpenCode derives the agent name from the filename (e.g.,
> `drone-protocol.md` → agent name "drone-protocol"). The `name` field in
> `claude:` is not carried over.

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
  name: Drone
  permissionMode: bypassPermissions
  maxTurns: 50

opencode:
  model: opus              # override: OpenCode gets opus instead of sonnet
  mode: subagent
  steps: 50
---
```

Claude output: `model: sonnet` (shared default). OpenCode output: `model: opus`
(overridden by opencode section).

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

Valid values: `[claude]`, `[opencode]`, `[claude, opencode]` (default if
omitted).

When `platforms` is set, the file is **skipped entirely** for non-listed
platforms.

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

| Rule                 | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| **Unmarked content** | Appears on ALL platforms (default)                         |
| `<!-- @claude -->`   | Opens a Claude Code-only section                           |
| `<!-- @opencode -->` | Opens an OpenCode-only section                             |
| `<!-- @end -->`      | Closes the current platform section                        |
| **Own line**         | Markers MUST be on their own line (no inline markers)      |
| **No nesting**       | Conditional sections cannot be nested                      |
| **Whitespace**       | Leading/trailing blank lines inside sections are preserved |
| **Pairing**          | Every `@platform` marker must have a matching `@end`       |

### 2.3 Common Pattern — Dispatch Blocks

The most frequent use is for agent dispatch syntax, which differs between
platforms:

````markdown
## Dispatch Workers

<!-- @claude -->

Use the `Agent` tool to dispatch a Drone:

```json
{
  "subagent_type": "drone-protocol",
  "description": "Implement the auth middleware",
  "run_in_background": true
}
```
````

<!-- @end -->

<!-- @opencode -->

Use `task()` to dispatch a worker:

```
task(
  subagent_type="drone-protocol",
  load_skills=[],
  description="Implement the auth middleware",
  run_in_background=true,
  prompt="..."
)
```

<!-- @end -->

````
### 2.4 Adjacent Platform Blocks

When providing platform-specific alternatives for the same concept, place them
adjacent. This makes it clear they are alternatives, not separate features:

```markdown
<!-- @claude -->
Spawn the Sentinel:
Agent(subagent_type="sentinel-protocol", ...)
<!-- @end -->
<!-- @opencode -->
Spawn the review agent:
task(subagent_type="sentinel-protocol", ...)
<!-- @end -->
````

---

## 3. Field Mapping Reference

### 3.1 Agent Frontmatter — Claude Code → OpenCode

| Claude Code Field                       | OpenCode Equivalent                                 | Notes                               |
| --------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| `name: Drone`                           | (filename: `drone-protocol.md`)                     | OpenCode derives name from filename |
| `model: sonnet`                         | `model: sonnet`                                     | Shared — identical semantics        |
| `description: "..."`                    | `description: "..."`                                | Shared — required on both platforms |
| `permissionMode: bypassPermissions`     | `permission: { "*": allow }`                        | Grant all tool permissions          |
| `permissionMode: auto`                  | _(omit or use granular)_                            | OpenCode default is ask-per-tool    |
| `disallowedTools: [Agent]`              | `tools: { task: false }`                            | Disable specific tools              |
| `disallowedTools: [Agent, Write, Edit]` | `tools: { task: false, write: false, edit: false }` | Multiple tool restrictions          |
| `maxTurns: 50`                          | `steps: 50`                                         | Maximum agent iterations            |
| _(n/a)_                                 | `mode: subagent`                                    | Required for non-primary agents     |
| _(n/a)_                                 | `mode: primary`                                     | Replaces the default lead agent     |
| _(n/a)_                                 | `hidden: true`                                      | Hide from agent selector UI         |
| _(n/a)_                                 | `color: "#hex"`                                     | Agent display color                 |
| _(n/a)_                                 | `temperature: 0.7`                                  | Model temperature                   |
| _(n/a)_                                 | `reasoningEffort: high`                             | Reasoning budget hint               |

### 3.2 Complete Agent Mapping

| Agent      | Protocol Name                 | Model  | Claude `permissionMode`           | Claude `disallowedTools` | OC `mode` | OC `permission` | OC `tools`                               | OC `steps` |
| ---------- | ----------------------------- | ------ | --------------------------------- | ------------------------ | --------- | --------------- | ---------------------------------------- | ---------- |
| Borg Queen | `queen-coordination-protocol` | opus   | _(n/a — `platforms: [opencode]`)_ | —                        | primary   | `"*": allow`    | —                                        | 80         |
| Drone      | `drone-protocol`              | sonnet | bypassPermissions                 | [Agent]                  | subagent  | `"*": allow`    | `task: false`                            | 50         |
| Sentinel   | `sentinel-protocol`           | opus   | bypassPermissions                 | [Agent, Write, Edit]     | subagent  | `"*": allow`    | `task: false, write: false, edit: false` | 20         |
| Probe      | `probe-protocol`              | sonnet | bypassPermissions                 | [Agent, Write, Edit]     | subagent  | `"*": allow`    | `task: false, write: false, edit: false` | 25         |
| Designate  | `designate-protocol`          | opus   | bypassPermissions                 | [Agent, Write, Edit]     | subagent  | `"*": allow`    | `task: false, write: false, edit: false` | 30         |
| Locutus    | `locutus-protocol`            | opus   | bypassPermissions                 | [Agent, Write, Edit]     | subagent  | `"*": allow`    | `task: false, write: false, edit: false` | 30         |

> **Note**: Claude Code has no Queen agent. The lead session orchestrates
> directly via the `/trimatrix` skill. Borg Queen is OpenCode-only because
> OpenCode requires a primary agent file (`mode: primary`) — the
> `queen-coordination-protocol.md` source uses `platforms: [opencode]` to
> restrict it to that target.

### 3.3 Tool Name Mapping

| Claude Code Tool | OpenCode Tool                   | Notes                     |
| ---------------- | ------------------------------- | ------------------------- |
| `Agent`          | `task`                          | Subagent dispatch         |
| `Write`          | `write`                         | File write                |
| `Edit`           | `edit`                          | File edit                 |
| `Read`           | `read`                          | File read                 |
| `Glob`           | `glob`                          | File search               |
| `Grep`           | `grep`                          | Content search            |
| `Bash`           | `bash`                          | Shell commands            |
| `WebSearch`      | `google_search` / `websearch_*` | Web search                |
| `WebFetch`       | `webfetch`                      | URL fetch                 |
| `TeamCreate`     | _(no equivalent)_               | Use Brain tasks + records |
| `SendMessage`    | _(no equivalent)_               | Use Brain task comments   |
| `TeamDelete`     | _(no equivalent)_               | N/A                       |

---

## 4. Directory Conventions

### 4.1 Source Layout (`src/`)

```
src/
├── agents/                    # Combined agent definitions
│   ├── queen-coordination-protocol.md     # platforms: [opencode]
│   ├── drone-protocol.md
│   ├── sentinel-protocol.md
│   ├── probe-protocol.md
│   ├── designate-protocol.md
│   └── locutus-protocol.md
├── skills/                    # Skill definitions (shared body + conditionals)
│   ├── trimatrix/SKILL.md           # Unified orchestration supergraph
│   ├── compliance-sphere/SKILL.md   # Multi-sentinel review formation
│   ├── recon-sphere/SKILL.md        # Multi-agent investigation formation
│   └── fabrication-cube/SKILL.md    # Parallel build formation
├── rules/                     # Process rules
│   ├── routing.md             #   Classifier signals, override gates, tier mapping
│   ├── personality.md         #   Borg collective voice (source of truth)
│   ├── token-economy.md       #   Token-efficient agent behavior
│   └── error-taxonomy.md      #   Borg error designations
├── hooks/
│   ├── claude/                # Python/Shell hooks (Claude Code)
│   │   ├── route-classify.py  #   UserPromptSubmit — routing signals
│   │   ├── track-cost.py
│   │   ├── track-agents.py
│   │   ├── track-compactions.py
│   │   ├── warn-compaction.py
│   │   ├── pre-commit
│   │   └── post-commit
│   ├── opencode/              # JS/TS plugins (OpenCode)
│   │   └── unimatrix-hooks.ts
│   └── SPEC.md                # Shared hook logic specification
├── themes/                    # OpenCode TUI themes (5 Borg variants)
├── tui/tui.json               # OpenCode TUI configuration
└── shared/                    # Platform-agnostic assets
    ├── statusline.py          # Claude Code status line
    └── statusline.sh          # Shell status line helper
```

### 4.2 Build Output (`dist/`)

```
dist/
├── claude-code/
│   └── .claude/
│       ├── agents/*.md            # Claude-specific frontmatter + Claude body
│       ├── skills/                # Each skill directory copied whole
│       │   ├── trimatrix/         #   SKILL.md + modes/ + reference docs
│       │   ├── compliance-sphere/
│       │   ├── recon-sphere/
│       │   └── fabrication-cube/
│       ├── rules/*.md
│       └── settings.json          # Hooks config + spinner verbs + statusline
└── opencode/
    ├── .opencode/
    │   ├── agents/*.md            # OpenCode-specific frontmatter + OC body
    │   └── plugins/*.ts           # Compiled OpenCode hook plugins
    ├── .claude/
    │   └── skills/                # OC reads .claude/skills/ natively
    │       └── {trimatrix, compliance-sphere, recon-sphere, fabrication-cube}/
    ├── themes/*.json              # 5 Borg-aesthetic TUI themes
    └── tui.json
```

---

## 5. Build System Interface

```bash
# Generate for specific platform
python3 build.py --target claude
python3 build.py --target opencode
python3 build.py --target all                # Both platforms (default)

# Validate source files without generating
python3 build.py --validate

# Remove dist/ directory
python3 build.py --clean

# Inject Borg personality into a registered brain's AGENTS.md
python3 build.py --inject-tone <brain-name>  # Single brain
python3 build.py --inject-tone               # All registered brains
```

The same surface is exposed via `just`: `just build`, `just build-claude`,
`just build-opencode`, `just validate`, `just clean`, `just inject <brain>`.

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
