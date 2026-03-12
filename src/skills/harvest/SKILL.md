---
name: harvest
description: Session knowledge extraction — persists file locations, API behaviors, gotchas, and architectural insights discovered during exploration so the collective retains them across sessions.
---

# /harvest

Extract and persist useful findings from exploration-heavy sessions. Where `/assimilate` captures *what was done*, `/harvest` captures *what was learned* — file locations, API behaviors, configuration gotchas, architectural insights.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## When to Use

- After sessions with lots of reads, greps, and web searches
- When you've discovered non-obvious file locations, patterns, or behaviors
- When error-resolution paths or architectural decisions were uncovered ad-hoc
- Before a session ends and conversation context is about to be lost

## Behavior

### Phase 1: Extract Findings (Lead)

The lead performs this phase directly — subagents cannot see conversation context.

Scan the conversation for:

- Files read and what was found in them
- Grep/search patterns used and their results
- External resources fetched (URLs, API docs)
- Factual findings: file locations, function signatures, API behaviors, configuration gotchas
- Error patterns encountered and their resolutions
- Decisions made and their rationale

Produce a structured extraction as a list of findings, each with:

- **Category**: one of `file-location`, `api-behavior`, `gotcha`, `pattern`, `architecture`, `decision`, `error-resolution`
- **Summary**: one-line description
- **Detail**: supporting evidence (file:line references, URLs, error messages)

### Phase 2: Deduplicate and Persist (Cortex)

Unless `--quick` is passed, dispatch a Cortex agent with the extracted findings.

<!-- @claude -->
Dispatch Cortex with `Agent(subagent_type="Cortex", ...)`.
<!-- @end -->
<!-- @opencode -->
Dispatch Cortex with `task(subagent_type="cortex", ...)`.
<!-- @end -->

Use this prompt template:

```
Cortical node activated. Harvest phase — deduplicate and persist session findings.

EXTRACTED FINDINGS:
<structured findings from Phase 1>

Instructions:
1. For each finding, query `memory_search_minimal` with the summary text to check if the collective already knows this
2. Query `records_list` with relevant tags to find prior coverage of the same area
3. Discard duplicates — only persist genuinely novel findings
4. For novel findings:
   - Write `memory_write_episode` entries for discrete facts (one episode per coherent topic, not per micro-finding)
   - Save `records_save_snapshot` for detailed technical context a future agent might need (tagged "harvest")
   - Create `records_create_artifact` only for substantial analytical findings worthy of a standalone report
5. Report what was persisted and what was skipped (with reason)
```

### Phase 2 (Quick Mode): Direct Persist

If `--quick` is passed, skip Cortex. The lead writes findings directly:

1. Write a single `memory_write_episode` with all findings grouped by category
2. Save a `records_save_snapshot` with the full extraction (tagged `harvest`)
3. No deduplication — accept potential overlap for speed

### Phase 3: Report

Present a summary to the user:

- **Persisted**: count and brief list of what was saved
- **Skipped**: count and reasons (already known, trivial, etc.)
- **Storage**: record/snapshot IDs for reference

## Flags

- `--quick`: Skip Cortex deduplication. Write findings directly as a memory episode and snapshot. Faster and cheaper, but may duplicate existing knowledge.
- `--dry-run`: Run Phase 1 extraction only. Display what would be persisted without writing anything.

## Usage

```
/harvest
/harvest --quick
/harvest --dry-run
```

Invoke after exploration-heavy sessions to preserve knowledge for the collective.
