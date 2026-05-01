# Validation Guide — unimatrix dual-platform build

This document defines how unimatrix sources are validated. It covers automated
gates (CI + local `just check`) and the manual smoke tests required when landing
changes that touch dispatch, hooks, or platform-specific behavior.

## Automated Validation

All automated checks run locally via `just check` and on every PR via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

### `just check`

```bash
just check     # → check-py + check-ts + validate
```

| Step       | Command                                                 | Surface                                                                |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `check-py` | `python -m py_compile build.py src/hooks/claude/*.py …` | Python syntax check across `build.py`, hooks, and `src/shared/*.py`    |
| `check-ts` | `deno check src/hooks/opencode/unimatrix-hooks.ts`      | TypeScript type-check of the OpenCode hook plugin                      |
| `validate` | `python build.py --validate`                            | Structural validation of agent/skill source files (frontmatter + body) |

The `validate` step enforces:

- [x] Orphaned `<!-- @end -->` without an opening marker → fail
- [x] Unclosed `<!-- @platform -->` without `<!-- @end -->` → fail
- [x] Nested conditional markers → fail
- [x] Unknown platform names (only `claude` and `opencode` are valid) → fail
- [x] Missing required frontmatter fields (`description` for agents) → fail
- [x] Invalid `platforms` values → fail

### CI gates

GitHub Actions runs three parallel jobs on every pull request and push to
`master`:

| Job        | Command                                            | Purpose                                                 |
| ---------- | -------------------------------------------------- | ------------------------------------------------------- |
| **Format** | `deno fmt --check`                                 | Tree-wide formatting (`deno.json` excludes are honored) |
| **Lint**   | `deno lint`, `just check-ts`, `just check-py`      | Lint + Deno type-check + Python `py_compile`            |
| **Tests**  | `just validate`, `deno test src/skills/trimatrix/` | Structural validation + trimatrix engine test suite     |

Toolchain versions are pinned in `.mise.toml` and provisioned by
[`jdx/mise-action`](https://github.com/jdx/mise-action) — CI runs the same
`deno`, `python`, and `just` versions developers run locally. The Deno module
cache is keyed on `deno.lock` for warm-run speedups.

A formatting violation, lint warning, or failing test blocks the PR check.

### Trimatrix engine tests

The graph engine ships its own test suite under
`src/skills/trimatrix/*.test.ts`:

- `graph.test.ts` — graph data structure, wave computation, cycle detection
- `state.test.ts` — state machine transitions, checkpoint serialization
- `brain-sync.test.ts` — brain task synchronization
- `convergence.test.ts` — per-node convergence loop (Protocol C)
- `designate.test.ts` — Borg designation generation
- `event-log-writer.test.ts` — event log persistence
- `materialize.test.ts` — plan materialization (markdown render)
- `memory-leaks.test.ts` — `/tmp` cleanup, subprocess listener accounting
- `server.test.ts`, `server-handler.test.ts` — MCP server surface
- `triviality.test.ts` — review tier classifier (TRIVIAL / NON_TRIVIAL)

Run the full suite locally:

```bash
deno test src/skills/trimatrix/
```

## Manual Smoke Tests

Manual tests are required when changes touch agent dispatch, hook execution, or
platform-specific behavior. Automated gates cannot exercise the live runtime.

### Setup

```bash
# Install pinned toolchain
mise install

# Build, compile, and install both platforms globally
just install-global
```

Restart your editor / CLI after installation to pick up changes.

### Claude Code

| #  | Test               | How                                                               | Expected                                                                           |
| -- | ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| C1 | Agents load        | Use `/agents` or check the agent picker                           | 5 adjuncts visible: Drone, Sentinel, Probe, Designate, Locutus                     |
| C2 | Skills load        | Trigger the skill list                                            | `/trimatrix`, `/compliance-sphere`, `/recon-sphere`, `/fabrication-cube` available |
| C3 | Routing hook fires | Submit a prompt; check `/tmp/unimatrix-routing-{session_id}.json` | File exists with `signals` and `score` fields                                      |
| C4 | Trimatrix dispatch | Run `/trimatrix update the auth middleware`                       | Classifier scores → tier; routes to mode; graph initialized                        |
| C5 | Adjunct dispatch   | Run a T2 trimatrix directive                                      | `Agent` tool invokes `drone-protocol`; designation assigned                        |
| C6 | Sentinel review    | Run `/compliance-sphere` on a recent change                       | Sentinel adjunct dispatched; verdict returned with evidence                        |
| C7 | Hooks execute      | Make a commit                                                     | `pre-commit` and `post-commit` hooks fire; `post-commit` reinstalls                |
| C8 | Status line        | Open a session                                                    | Status line shows active agents, compaction count, session cost                    |
| C9 | Brain MCP          | Ask "what's next?"                                                | `tasks_next` called; ready task surfaced                                           |

### OpenCode

| #  | Test                | How                                               | Expected                                                      |
| -- | ------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| O1 | Borg Queen loads    | Open a session                                    | Primary agent is Borg Queen (`mode: primary`)                 |
| O2 | Subagents load      | Check the agent list                              | 5 subagents: Drone, Sentinel, Probe, Designate, Locutus       |
| O3 | Skills load         | Trigger the skill list                            | All four skills available, read from `.claude/skills/`        |
| O4 | Subagent dispatch   | Ask Borg Queen to dispatch a Drone                | `task(subagent_type="drone-protocol", ...)` invokes the agent |
| O5 | Plugin hooks        | Use tools, check cost tracking                    | `tool.execute.after` fires; cost tracked in state file        |
| O6 | Theme & TUI applied | Open the TUI                                      | Borg theme active (per `~/.config/opencode/tui.json`)         |
| O7 | Permissions         | Verify subagents respect `tools: { task: false }` | Subagents cannot dispatch sub-subagents                       |

### Cross-Platform

| #  | Test                       | How                              | Expected                                                                 |
| -- | -------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| X1 | Same skill, both platforms | Run `/trimatrix` on both         | Lead routes via classifier on both; uses platform-native dispatch syntax |
| X2 | Build reproducibility      | Run `just build` twice           | Identical output both times                                              |
| X3 | Install idempotency        | Run `just install-global` twice  | No errors, symlinks unchanged                                            |
| X4 | Uninstall cleans up        | Run `bash uninstall.sh --global` | Symlinks removed, MCP server unregistered                                |

## When validation must pass

- **Before a PR is opened** — `just check` must pass locally.
- **Before merge** — all CI gates (Format, Lint, Tests) must be green.
- **Before a release / global install** — manual smoke tests for the platform(s)
  affected by the change must pass on a real project.

Branch protection is not configured by the workflow — repo admins must enable
the relevant checks in repository settings to require CI to pass before merge.
