---
description: Cross-cutting rules for minimizing token consumption across all agents
---

# Token Economy

All agents must minimize token consumption. Tokens cost money and time.

## Read strategically

- **Never read a file you don't need.** If a Grep match gives you enough
  context, stop there.
- **Use `offset` and `limit`** on Read when you only need a specific section of
  a large file. Don't read 2000 lines to check one function.
- **Check prior intelligence first.** Before searching or reading, query
  `records_list` and `memory_search_minimal` — the answer may already exist from
  a prior probe, designate, or drone. Reuse existing snapshots and artifacts
  instead of re-exploring.
- **Don't re-read files you've already read** in the same session unless they've
  been modified since.

## Search efficiently

- **Grep before Read.** Use Grep to locate the relevant lines, then Read only
  the range you need with `offset`/`limit`.
- **Use `head_limit`** on Grep/Glob when you only need the first few matches —
  don't ingest hundreds of results.
- **Use `output_mode: "files_with_matches"`** (the default) when you only need
  file paths, not content.
- **Prefer `type` over `glob`** in Grep for standard file types — it's more
  efficient.

## Produce concise output

- **Keep snapshots under 2KB.** Summarize, don't dump.
- **Keep task comments brief.** State what changed, what was verified, blockers
  — nothing more.
- **Don't echo file contents in messages.** Reference `file:line` instead of
  quoting large blocks.

## Dedicated tools before scripting

- **Never use Bash to read, search, check, or transform file contents.** No
  `ls <file>`, no `cat`, no `head`, no `tail`, no `grep`, no `awk`, no `sed`, no
  `python3 -c`, no `bash -c`. Use the dedicated tools:
  - **Check existence / find files** → Glob tool (not `ls`)
  - **Read** files → Read tool (with `offset`/`limit` for sections)
  - **Search** content → Grep tool (not `grep` or `rg` in Bash)
  - **Parse JSON** → `jq` (the only acceptable Bash usage for text
    transformation)
- **If Bash is not executing a system command, you are using the wrong tool.**
  Bash is for `git`, `npm`, `make`, `jq`, process management — not for reading
  or transforming text.
- **Never chain file operations in Bash.**
  `ls <file> && grep -n <pattern> <file>` is forbidden. Use Glob to verify
  existence, Grep to search content.
- **Never pipe tool output through a scripting language.** If the output needs
  filtering, use Grep or `jq`.
- **Never verify file deployment with Bash.** After writing or editing a file,
  use Glob (existence) or Read (content) — not
  `ls ... && echo "deployed" && grep ...`.

### Forbidden → correct patterns

| Forbidden (Bash)                        | Correct (dedicated tool)                            |
| --------------------------------------- | --------------------------------------------------- |
| `ls path/to/file.md && echo "exists"`   | Glob: `pattern: "path/to/file.md"`                  |
| `grep -n "pattern" path/to/file.md`     | Grep: `pattern: "pattern", path: "path/to/file.md"` |
| `cat path/to/file.md`                   | Read: `file_path: "path/to/file.md"`                |
| `head -20 path/to/file.md`              | Read: `file_path: "...", limit: 20`                 |
| `ls path/ && grep -n "fn" path/file.md` | Glob + Grep (two tool calls)                        |

## Avoid redundant work

- **Check `records_list`** for prior probe/designate/drone artifacts before
  re-exploring an area.
- **Check `memory_search_minimal`** before web searching — the collective may
  already know.
- **If a sibling agent already covered a file or area** (visible in prior
  snapshots), skip it and build on their findings.
