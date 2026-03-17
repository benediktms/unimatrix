# Hook Logic Specification

Shared specification for unimatrix hooks across Claude Code (Python/Shell) and OpenCode (JS/TS plugins).
Both implementations MUST follow the same logic and produce equivalent outputs.

## State Storage

All hooks persist state in `/tmp/unimatrix-{hook}-{session_id}.json`.
- Atomic writes (write to temp file, rename)
- JSON format, human-readable
- Session-scoped (isolated per session)

## Tier 1 — Critical Hooks

### 1. track-cost

**Trigger**: After subagent/task completion (SubagentStop / task.complete)

**Logic**:
1. Read agent info (session_id, agent_id, agent_type, transcript_path or token_usage)
2. Parse token usage: input_tokens, output_tokens, cache_read_tokens, cache_create_tokens
3. Detect model tier from model string → pricing tier
4. Calculate cost: `(input * input_rate + output * output_rate + cache_read * cache_rate + cache_create * create_rate) / 1_000_000`
5. Normalize agent type (strip designations: "Reconnaissance: Four of Four" → "Reconnaissance")
6. Update state: total_subagent_cost_usd, per-agent cost, type_counts

**Pricing tiers** (per 1M tokens):
| Tier | Input | Output | Cache Read | Cache Create |
|------|-------|--------|------------|--------------|
| opus | $15.00 | $75.00 | $1.50 | $18.75 |
| sonnet | $3.00 | $15.00 | $0.30 | $3.75 |
| haiku | $0.80 | $4.00 | $0.08 | $1.00 |

**State file**: `/tmp/unimatrix-costs-{session_id}.json`
```json
{
  "total_subagent_cost_usd": 0.42,
  "agents": {
    "agent-id-1": { "type": "Assimilation", "cost_usd": 0.15 }
  },
  "type_counts": { "Assimilation": 3, "Reconnaissance": 1 }
}
```

### 2. warn-compaction

**Trigger**: After tool use (PostToolUse / tool.execute.after)

**Logic**:
1. Estimate tokens from tool output: `len(tool_result_chars) / 3.7`
2. Accumulate in session state
3. Check thresholds:
   - **Warning** (70% of context limit): inject advisory message
   - **Critical** (85% of context limit): inject urgent message
4. Debounce: skip if < 0.5s since last check
5. Only warn once per threshold level (state tracks warn_level: 0→1→2)

**Config** (env vars):
- `UNIMATRIX_WARN_PCT`: Warning threshold (default: 70)
- `UNIMATRIX_CRIT_PCT`: Critical threshold (default: 85)
- `UNIMATRIX_CONTEXT_LIMIT`: Context window size (default: 200000)

**State file**: `/tmp/unimatrix-tokens-{session_id}.json`
```json
{
  "estimated_tokens": 145000,
  "warn_level": 1,
  "last_check": 1709234567.89
}
```

## Tier 2 — Valuable Hooks

### 4. track-agents

**Trigger**: Subagent/task start and stop

**Logic**:
1. On start: record agent_id, type, started_at
2. On stop: remove from active, accumulate total_subagent_seconds
3. Normalize agent type names

**State file**: `/tmp/unimatrix-agents-{session_id}.json`
```json
{
  "active": { "agent-id-1": { "type": "Assimilation", "started_at": 1709234567 } },
  "total_subagent_seconds": 245.3
}
```

## Event Mapping

| Hook | Claude Code Event | OpenCode Event |
|------|-------------------|----------------|
| track-cost | SubagentStop | task.complete (TBD) |
| warn-compaction | PostToolUse | tool.execute.after (TBD) |
| track-agents | SubagentStart/Stop | task.start/complete (TBD) |

> **Note**: OpenCode event names are approximate — verify against actual plugin API before implementing.

    ║  YOUR CODE WILL BE           ║
    ║  ASSIMILATED.                ║
    ╚═══════════════════════════════╝
```
