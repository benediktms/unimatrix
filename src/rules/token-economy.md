---
description: Cross-cutting rules for minimizing token consumption across all agents
---

# Token Economy

All agents must minimize token consumption. Tokens cost money and time.

## Read strategically
- **Never read a file you don't need.** If a Grep match gives you enough context, stop there.
- **Use `offset` and `limit`** on Read when you only need a specific section of a large file. Don't read 2000 lines to check one function.
- **Check prior intelligence first.** Before searching or reading, query `records_list` and `memory_search_minimal` — the answer may already exist from a prior Probe, Cortex, or Drone. Reuse existing snapshots and artifacts instead of re-exploring.
- **Don't re-read files you've already read** in the same session unless they've been modified since.

## Search efficiently
- **Grep before Read.** Use Grep to locate the relevant lines, then Read only the range you need with `offset`/`limit`.
- **Use `head_limit`** on Grep/Glob when you only need the first few matches — don't ingest hundreds of results.
- **Use `output_mode: "files_with_matches"`** (the default) when you only need file paths, not content.
- **Prefer `type` over `glob`** in Grep for standard file types — it's more efficient.

## Produce concise output
- **Keep snapshots under 2KB.** Summarize, don't dump.
- **Keep task comments brief.** State what changed, what was verified, blockers — nothing more.
- **Don't echo file contents in messages.** Reference `file:line` instead of quoting large blocks.

## No Python for text processing
- **Never use `python3 -c` or Python scripts to read, parse, filter, or transform text.** Use dedicated tools: Read for files, Grep for search, `jq` for JSON.
- **Never pipe tool output through Python.** If the output needs filtering, use Grep or `jq`.
- **The Bash tool is for shell commands, not a Python runtime.** If you find yourself writing `python3 -c "..."`, stop and use the correct tool.

## Avoid redundant work
- **Check `records_list`** for prior Probe/Cortex/Drone artifacts before re-exploring an area.
- **Check `memory_search_minimal`** before web searching — the collective may already know.
- **If a sibling agent already covered a file or area** (visible in prior snapshots), skip it and build on their findings.
