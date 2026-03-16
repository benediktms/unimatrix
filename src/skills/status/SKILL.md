---
name: status
description: Display collective status — active agents, costs, session metrics, and hook diagnostics.
---

# /status

Display the current state of the collective: active agents, session costs, compaction warnings, and adaptation metrics. Reads from hook state files written by unimatrix hooks.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Behavior

1. **Read state files** from `/tmp/`:
   - `unimatrix-agents-{session_id}.json` — active agents, total seconds
   - `unimatrix-costs-{session_id}.json` — cost per agent, totals
   - `unimatrix-tokens-{session_id}.json` — estimated token usage, warn level
   - `unimatrix-compactions-{session_id}.json` — compaction count
   - `unimatrix-learner-{session_id}.json` — patterns captured

2. **Determine session ID** — Check recent state files in /tmp/ matching `unimatrix-*` pattern. Use the most recent session ID found.

3. **Render status dashboard**:

```
╔══════════════════════════════════════╗
║         UNIMATRIX STATUS             ║
╠══════════════════════════════════════╣
║ NEURAL NETWORK                       ║
║  Active adjuncts: 2                  ║
║   ├─ Assimilation: Three of Five .. WORKING ║
║   └─ Reconnaissance: Seven of Nine .. WORKING ║
║  Total adjunct time: 245.3s          ║
╠══════════════════════════════════════╣
║ COLLECTIVE RESOURCES                 ║
║  Session cost: $0.4200               ║
║   ├─ Assimilation (3x): $0.3150            ║
║   └─ Reconnaissance (1x): $0.1050            ║
║  Context usage: ~67% ██████████░░░░  ║
║  Regeneration cycles: 0             ║
╠══════════════════════════════════════╣
║ ADAPTATION METRICS                   ║
║  Patterns captured: 3                ║
║  Warn level: 0 (nominal)            ║
╚══════════════════════════════════════╝
```

4. **Handle missing data gracefully** — If a state file doesn't exist, show "No data" for that section. Never error.

## Usage

```
/status
```

## Platform Notes

<!-- @claude -->
Read state files directly using Bash: `cat /tmp/unimatrix-*-SESSION_ID.json 2>/dev/null`
The session ID is available from the most recent state file.
<!-- @end -->
<!-- @opencode -->
Read state files directly using Bash: `cat /tmp/unimatrix-*-SESSION_ID.json 2>/dev/null`
The session ID is available from the most recent state file.
<!-- @end -->
