---
name: bisect
description: Guided binary search through commits to find which commit introduced a bug or regression — supports automated mode (--test) and AI-guided mode with Probe analysis.
---

# /bisect

Find which commit introduced a bug or regression using `git bisect`. Runs in an isolated worktree to avoid disturbing the user's working tree. Supports automated mode with a test command or AI-guided mode where a Probe agent analyzes each commit's diff.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## When to Use

- **Regression hunting** — you know something broke but don't know when
- **Automated bisect** — you have a test command that reliably reproduces the failure
- **AI-guided bisect** — you can describe the symptom but have no automated test

## Behavior

### Step 1: Validate Prerequisites

Check for a clean working tree:

```bash
git status --porcelain
```

If the output is non-empty, warn the user and abort. Uncommitted changes could be lost when the worktree checks out different commits.

### Step 2: Enter Worktree

<!-- @claude -->
Use `EnterWorktree` with name `bisect-<timestamp>` (e.g., `bisect-1710000000`) to create an isolated worktree.
<!-- @end -->
<!-- @opencode -->
Use `git worktree add` to create an isolated worktree with a timestamped branch name (e.g., `bisect-<timestamp>`).
<!-- @end -->

### Step 3: Resolve Commit Range

- **Bad commit**: default `HEAD`, or user-provided `--bad <ref>`
- **Good commit**: if `--good <ref>` provided, use it directly. Otherwise:
  - If `--path` is set, find the last commit that touched those paths within ~20 commits back
  - Else, use `HEAD~20` or the most recent tag, whichever is closer to HEAD
- Validate both refs exist with `git rev-parse --verify <ref>`

### Step 4: Start Bisect

```bash
git bisect start
git bisect bad <bad-ref>
git bisect good <good-ref>
```

If `--path` was provided, append `-- <path>` to `git bisect start`.

Report to the user: "Bisecting N commits (~M steps remaining)"

### Step 5: Execute Bisect

#### Step 5a: Automated Mode (`--test` provided)

```bash
git bisect run <test-command>
```

Parse the output for the first bad commit line, then jump to Step 6.

#### Step 5b: AI-Guided Mode (no `--test`)

Loop up to 20 iterations:

1. Get the current commit:
   ```bash
   git rev-parse HEAD
   git log -1 --format="%H %an %ae %ad %s"
   ```

2. Get the commit's changes:
   ```bash
   git show --stat HEAD
   git show HEAD        # or: git show HEAD -- <paths> if --path is set
   ```

3. Dispatch a Probe agent with the commit diff and symptom description.

<!-- @claude -->
   Use `Agent(subagent_type="Probe", ...)` for dispatch.
<!-- @end -->
<!-- @opencode -->
   Use `task(subagent_type="probe", ...)` for dispatch.
<!-- @end -->

   Probe prompt template:

   ```
   You are analyzing a commit during a git bisect to find which commit introduced a regression.

   SYMPTOM: <user's symptom description>
   COMMIT: <hash> by <author> on <date>
   MESSAGE: <commit message>

   DIFF:
   <git show output for this commit>

   Based on this commit's changes, assess whether this commit could have introduced the described symptom.

   Return EXACTLY ONE verdict on the first line:
   - LIKELY_BAD — this commit's changes are likely to cause the symptom
   - LIKELY_GOOD — this commit's changes are unrelated to the symptom
   - UNCERTAIN — cannot determine from the diff alone

   Then briefly explain your reasoning (2-3 sentences max).
   ```

4. Parse the Probe verdict and advance bisect:
   - `LIKELY_BAD` → `git bisect bad`
   - `LIKELY_GOOD` → `git bisect good`
   - `UNCERTAIN` → `git bisect skip`

5. Check if the bisect output contains "is the first bad commit". If so, break the loop.

### Step 6: Present Results

- Show the identified bad commit: hash, author, date, message
- Show the commit's full diff (or a `--stat` summary if the diff is large)
- If `--path` was used, highlight changes to those paths specifically
- If AI-guided, note any skipped commits and the confidence of the result

### Step 7: Cleanup

```bash
git bisect reset
```

<!-- @claude -->
Use `ExitWorktree` with `action: "remove"` and `discard_changes: true` to remove the worktree.
<!-- @end -->
<!-- @opencode -->
Use `git worktree remove` to remove the worktree, then delete the temporary branch.
<!-- @end -->

## Usage

```
/bisect <symptom description> [--test "<command>"] [--good <ref>] [--bad <ref>] [--path <path>]
```

## Options

| Option | Description |
|---|---|
| `<symptom>` | Description of the bug or regression (required) |
| `--test "<cmd>"` | Shell command that exits 0 for good, non-zero for bad |
| `--good <ref>` | Known-good commit, tag, or branch |
| `--bad <ref>` | Known-bad commit (default: HEAD) |
| `--path <path>` | Restrict bisect and diff analysis to this path |

## Examples

```
/bisect The login page throws a TypeError on submit
/bisect --test "npm test" Tests started failing in the auth module
/bisect --good v2.1.0 --path src/auth/ Authentication flow broke after the last release
/bisect --test "python -m pytest tests/api/" --good abc1234 API returns 500 on /users
```
