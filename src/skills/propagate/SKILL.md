---
name: propagate
description: Propagate the collective into an isolated worktree to plan, implement, and review a feature — runs the full /assemble flow in a fresh branch, returning results for merge.
---

# /propagate

<!-- @claude -->
Launch the full `/assemble` orchestration in an isolated git worktree. The collective plans, implements, and reviews in a separate branch — the main branch stays clean until you choose to merge.
<!-- @end -->
<!-- @opencode -->
Launch the full `/assemble` orchestration in an isolated git worktree. You plan, implement, and review in a separate branch — the main branch stays clean until you choose to merge.
<!-- @end -->

**This skill wraps `/assemble` in worktree isolation.** All planning, implementation, and review happens on a dedicated branch. When complete, present the results and let the user decide whether to merge.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Rules

- **Follow this flow exactly.** Do not skip the worktree setup or teardown steps.
- **All work happens inside the worktree.** Do not modify the original branch.
- **The `/assemble` flow runs unchanged** — follow its defined steps exactly as documented.
- **NEVER use Explore agents.** All reconnaissance uses `Probe` or `Cortex`.

## Flow

### Step 1: Enter Worktree

Create an isolated worktree for the task:

<!-- @claude -->
```
EnterWorktree:
  name: "<slugified short description from the user's prompt>"
```
<!-- @end -->
<!-- @opencode -->
Create a new worktree branch for isolated work. Use `git worktree add` with a descriptive branch name.
<!-- @end -->

The worktree name should be a short, kebab-case slug derived from the user's prompt (e.g., `add-websocket-support`, `refactor-auth-middleware`). Max 40 characters.

### Step 2: Run /assemble

<!-- @claude -->
Execute the full `/assemble` skill with the user's prompt. Follow every step of the assemble flow exactly as defined in the assemble skill — assessment, optional recon, planning, dispatch, monitoring, and Vinculum review.

**Important:** You are now inside the worktree. All file operations, git commits, and agent work happen on the worktree branch automatically.
<!-- @end -->
<!-- @opencode -->
Execute the full `/assemble` flow with the user's prompt. Follow every step — assessment, optional recon, planning, dispatch, monitoring, and Vinculum review.

**Important:** You are now inside the worktree. All file operations, git commits, and agent work happen on the worktree branch automatically.
<!-- @end -->

### Step 3: Present Results

When `/assemble` completes (Vinculum passes or user accepts), present a summary:

- **Branch name** — the worktree branch with all changes
- **Changes summary** — files modified, added, or removed (use `git diff --stat` against the base)
- **Vinculum verdict** — pass/fail and any notes
- **Merge command** — the exact command to merge changes back:
  ```
  git merge --squash <branch-name>
  ```

### Step 4: Ask About Merge

Ask the user what they want to do:

1. **Merge now** — squash-merge the worktree branch into the original branch, then clean up the worktree
2. **Keep worktree** — exit the worktree but leave it on disk for manual review or later merging
3. **Discard** — remove the worktree and its branch entirely

#### If merge:
<!-- @claude -->
```
ExitWorktree:
  action: "keep"
```
<!-- @end -->
<!-- @opencode -->
Exit the worktree (keep it on disk).
<!-- @end -->

Then squash-merge and clean up:
```bash
git merge --squash <branch-name>
git commit -m "<conventional commit message based on the work done>"
```

After a successful merge, remove the worktree:
```bash
git worktree remove <worktree-path>
git branch -d <branch-name>
```

#### If keep:
<!-- @claude -->
```
ExitWorktree:
  action: "keep"
```
<!-- @end -->
<!-- @opencode -->
Exit the worktree (keep it on disk).
<!-- @end -->

Report the worktree path and branch name so the user can return later.

#### If discard:
<!-- @claude -->
```
ExitWorktree:
  action: "remove"
  discard_changes: true
```
<!-- @end -->
<!-- @opencode -->
Remove the worktree and delete the branch.
<!-- @end -->

## Usage

```
/propagate <description of what you want to accomplish>
```

## Examples

```
/propagate Add WebSocket support for real-time notifications
/propagate Refactor the auth middleware to use JWT validation
/propagate Migrate the payment flow to the new Stripe API
```
