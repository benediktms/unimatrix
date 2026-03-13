# Validation Checklist — unimatrix dual-platform support

## Automated Validation (Completed ✅)

All structural validation passed:

| Check | Result |
|-------|--------|
| `build.py --target all` produces 36 files | ✅ Pass |
| Claude Code baseline diff (agent content) | ✅ Pass — cosmetic frontmatter reorder only |
| Claude Code agent frontmatter (name, model, permissionMode, maxTurns, disallowedTools) | ✅ Correct |
| OpenCode agent frontmatter (model, mode, steps, permission, tools) | ✅ Correct |
| No Claude-specific fields in OpenCode output | ✅ No leaks |
| No OpenCode-specific fields in Claude output | ✅ No leaks |
| Conditional markers stripped (`<!-- @claude -->`, `<!-- @opencode -->`) | ✅ None remaining |
| Skill dispatch syntax: Claude uses `Agent:`, OpenCode uses `task()` | ✅ Correct |
| Skills identical except platform dispatch sections | ✅ Verified |
| Rules files identical across platforms | ✅ Verified |
| Settings.json correct with placeholder resolution | ✅ Verified |
| File counts: 6 agents, 10 skills, rules per platform | ✅ All accounted for |
| `install.sh --claude` creates correct symlinks | ✅ Tested in temp dir |
| `install.sh --opencode` creates correct symlinks | ✅ Tested in temp dir |
| Hook plugin structure (braces, parens, exports, hooks) | ✅ Balanced, correct |

## Manual Runtime Validation (Required)

These tests require running actual platform sessions. Test on a real project.

### Setup

```bash
# 1. Build
python3 build.py --target all

# 2. Install to a test project
./install.sh --both --project ~/code/test-project
```

### Claude Code Tests

| # | Test | How | Expected |
|---|------|-----|----------|
| C1 | Agents load | `/agents` or check agent list | All 6 agents visible (Queen, Drone, Vinculum, Probe, Cortex, Subroutine) |
| C2 | Skills load | Check available skills | All 15 skills available (/assemble, /adapt, /comply, /swarm, /recon, /diagnose, /designate, /assimilate, /analyse, /reengage, /harvest, /bisect, /bookmark, /resume, /status) |
| C3 | Agent dispatch | Ask lead to dispatch a Drone | `Agent` tool invokes drone agent, receives response |
| C4 | Skill invocation | Run `/comply` on a recent change | Vinculum dispatched via `Agent` tool, returns review |
| C5 | Background agents | Ask lead to investigate codebase | Probe fires in background, results collected |
| C6 | Rules applied | Check if routing/coordination rules active | Lead follows intent classification table |
| C7 | Hooks execute | Make a commit, check logs | `post-commit` hook fires |
| C8 | Settings applied | Check `permissionMode`, `disallowedTools` | Agents have correct permissions |
| C9 | Brain MCP | Ask "what's next?" | `tasks_next` called, task presented |

### OpenCode Tests

| # | Test | How | Expected |
|---|------|-----|----------|
| O1 | Agents load | Check agent list in OpenCode | All 6 agents visible as subagents |
| O2 | Skills load | Check available skills | All 10 skills available (read from .claude/skills/) |
| O3 | Agent dispatch | Ask lead to dispatch a drone | `task(subagent_type="drone", ...)` invokes drone, receives response |
| O4 | Skill invocation | Run `/comply` on a change | Vinculum dispatched via `task()`, returns review |
| O5 | Background agents | Ask lead to investigate | Probe fires with `run_in_background=true`, results collected |
| O6 | Rules applied | Check routing/coordination rules | Lead follows intent classification |
| O7 | Plugin hooks | Use tools, check cost tracking | `tool.execute.after` fires, cost tracked in state |
| O8 | Compaction warning | Trigger session compaction | `event` hook warns about context loss |
| O9 | Agent permissions | Verify `mode: subagent`, `steps`, `tools` | Agents can't use `task()` when `tools.task: false` |
| O10 | Brain MCP | Ask "what's next?" | `tasks_next` called (if brain MCP connected) |

### Cross-Platform Tests

| # | Test | How | Expected |
|---|------|-----|----------|
| X1 | Same skill, both platforms | Run `/assemble` on both | Queen dispatched on both, uses platform-native dispatch syntax |
| X2 | AGENTS.md consistent | Check behavioral instructions | Both platforms read same AGENTS.md, follow same rules |
| X3 | Build reproducibility | Run `build.py` twice | Identical output both times |
| X4 | Install idempotency | Run `install.sh` twice | No errors, symlinks unchanged |

### Known Acceptable Differences

- Claude Code agent frontmatter: `permissionMode` line position shifted (cosmetic reorder)
- Queen agent: one sentence split into paragraph (semantic equivalent)
- These are expected artifacts of the YAML parser serialization order

## Validation Complete When

- [ ] All automated checks pass (see above — ✅ done)
- [ ] Claude Code C1-C9 pass on a real project
- [ ] OpenCode O1-O10 pass on a real project
- [ ] Cross-platform X1-X4 pass
