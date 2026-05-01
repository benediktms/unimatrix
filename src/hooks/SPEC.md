# Hook Logic Specification

Shared specification for unimatrix hooks across Claude Code (Python/Shell) and
OpenCode (JS/TS plugins). Both implementations MUST follow the same logic and
produce equivalent outputs.

## State Storage

All state-tracking hooks persist state in
`/tmp/unimatrix-{kind}-{session_id}.json`.

- Atomic writes (write to temp file, `os.rename` to final path)
- JSON format, human-readable
- Session-scoped (isolated per session)

## Hook Inventory

| Kind                   | Hook                   | Claude Code event        | OpenCode event             | State file                                |
| ---------------------- | ---------------------- | ------------------------ | -------------------------- | ----------------------------------------- |
| Routing classifier     | `route-classify.py`    | `UserPromptSubmit`       | _(in-skill router)_        | `unimatrix-routing-{session_id}.json`     |
| Subagent cost tracking | `track-cost.py`        | `SubagentStop`           | `task.complete` (TBD)      | `unimatrix-costs-{session_id}.json`       |
| Subagent activity      | `track-agents.py`      | `SubagentStart` / `Stop` | `task.start` / `complete`  | `unimatrix-agents-{session_id}.json`      |
| Compaction count       | `track-compactions.py` | `PreCompact`             | _(N/A — no equivalent)_    | `unimatrix-compactions-{session_id}.json` |
| Compaction warning     | `warn-compaction.py`   | `PostToolUse`            | `tool.execute.after` (TBD) | `unimatrix-tokens-{session_id}.json`      |

> **OpenCode event names** are approximate — verify against the actual plugin
> API before implementing.

Git hooks (`pre-commit`, `post-commit`) are installed separately via
`core.hooksPath` by `install.sh` and are not part of the platform event surface.

## Tier 1 — Critical Hooks

### route-classify

**Trigger**: After every user prompt (`UserPromptSubmit`)

**Logic**:

1. Read prompt JSON from stdin
2. Compute deterministic lexical + structural signals via regex / string ops:
   - `word_count`, `file_path_count`, `arch_keywords`, `debug_keywords`,
     `risk_keywords`, `question_depth`
   - `estimated_subtasks`, `cross_file_deps`, `impact_scope`, `reversibility`
   - `formation_hint` — review / research / build (matches
     `<formation-aliases>`)
   - `cross_repo_hint` — multi-repo intent
3. Write signals to `/tmp/unimatrix-routing-{session_id}.json`
4. Emit signals as `additionalContext` so they appear inline in the conversation
5. Swallow all exceptions — the prompt MUST always go through

Signal definitions, weights, and tier thresholds live in
[`src/rules/routing.md`](../rules/routing.md). The hook computes signals only;
scoring and tier mapping happen in-skill.

**State file** — `/tmp/unimatrix-routing-{session_id}.json`:

```json
{
  "signals": {
    "word_count": 12,
    "file_path_count": 0,
    "arch_keywords": 0,
    "risk_keywords": 0,
    "estimated_subtasks": 1,
    "formation_hint": null,
    "cross_repo_hint": false
  }
}
```

### track-cost

**Trigger**: After subagent / task completion (`SubagentStop` / `task.complete`)

**Logic**:

1. Read agent info (session_id, agent_id, agent_type, transcript_path or
   token_usage)
2. Parse token usage: input_tokens, output_tokens, cache_read_tokens,
   cache_create_tokens
3. Detect model tier from model string → pricing tier
4. Calculate cost:
   `(input * input_rate + output * output_rate + cache_read * cache_rate + cache_create * create_rate) / 1_000_000`
5. Normalize agent type (strip designations: "Probe: Four of Four" → "Probe")
6. Update state: `total_subagent_cost_usd`, per-agent cost, `type_counts`

**Pricing tiers** (per 1M tokens):

| Tier   | Input  | Output | Cache Read | Cache Create |
| ------ | ------ | ------ | ---------- | ------------ |
| opus   | $15.00 | $75.00 | $1.50      | $18.75       |
| sonnet | $3.00  | $15.00 | $0.30      | $3.75        |
| haiku  | $0.80  | $4.00  | $0.08      | $1.00        |

**State file** — `/tmp/unimatrix-costs-{session_id}.json`:

```json
{
  "total_subagent_cost_usd": 0.42,
  "agents": {
    "agent-id-1": { "type": "Drone", "cost_usd": 0.15 }
  },
  "type_counts": { "Drone": 3, "Probe": 1 }
}
```

### warn-compaction

**Trigger**: After tool use (`PostToolUse` / `tool.execute.after`)

**Logic**:

1. Estimate tokens from tool output: `len(tool_result_chars) / 3.7`
2. Accumulate in session state
3. Check thresholds:
   - **Warning** (70% of context limit): inject advisory message
   - **Critical** (85% of context limit): inject urgent message
4. Debounce: skip if `< 0.5s` since last check
5. Only warn once per threshold level (state tracks `warn_level`: 0→1→2)

**Config** (env vars):

- `UNIMATRIX_WARN_PCT` — warning threshold (default: 70)
- `UNIMATRIX_CRIT_PCT` — critical threshold (default: 85)
- `UNIMATRIX_CONTEXT_LIMIT` — context window size (default: 200000)

**State file** — `/tmp/unimatrix-tokens-{session_id}.json`:

```json
{
  "estimated_tokens": 145000,
  "warn_level": 1,
  "last_check": 1709234567.89
}
```

## Tier 2 — Valuable Hooks

### track-agents

**Trigger**: Subagent / task start and stop

**Logic**:

1. On start: record `agent_id`, type, `started_at`
2. On stop: remove from active, accumulate `total_subagent_seconds`
3. Normalize agent type names

**State file** — `/tmp/unimatrix-agents-{session_id}.json`:

```json
{
  "active": { "agent-id-1": { "type": "Drone", "started_at": 1709234567 } },
  "total_subagent_seconds": 245.3
}
```

### track-compactions

**Trigger**: Before context compaction (`PreCompact`)

**Logic**:

1. Read `session_id` from stdin
2. Load existing state (default `{ "compaction_count": 0 }`)
3. Increment `compaction_count`
4. Atomic write back to state file

**State file** — `/tmp/unimatrix-compactions-{session_id}.json`:

```json
{
  "compaction_count": 2
}
```

## Implementation Discipline

These rules apply to every hook script. They are derived from past failures —
each one represents a real outage.

- **Hooks must be executable.** Claude Code runs hooks as commands, not via
  `python3`. New hook files require `chmod +x`. The shebang
  `#!/usr/bin/env python3` selects the interpreter.
- **`subprocess.run` — `input=` vs `stdin=`.** `subprocess.run()` raises
  `ValueError` if both `input=` and `stdin=subprocess.PIPE` are passed. Use
  `input=data` alone (it implies `stdin=PIPE`). Use `stdin=subprocess.DEVNULL`
  only when there is no input data.
- **Atomic writes only.** Write to a temp file, then `os.rename` to the final
  state path. Never write the state file directly.
- **Swallow exceptions.** Hooks must never break the host session. Catch and
  log; do not re-raise.
- **Brain CLI vs MCP.** Hooks call the `brain` CLI, not MCP tools. For
  structured JSON:
  `echo '{"jsonrpc":"2.0","method":"<method>","params":{…},"id":1}' | brain mcp`.

## Cross-platform parity

The OpenCode TypeScript plugin (`src/hooks/opencode/unimatrix-hooks.ts`)
implements the same logic for the events listed in the inventory above. New
hooks added to Claude Code must either:

1. Have an OpenCode equivalent registered in the plugin, OR
2. Document explicitly in this file that the hook is Claude Code-only (e.g.,
   `track-compactions` — no `PreCompact` equivalent in OpenCode).
