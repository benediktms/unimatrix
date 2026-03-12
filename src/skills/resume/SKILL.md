---
name: resume
description: Restore context from a saved bookmark — branch state, in-progress tasks, recent changes, and next steps.
---

# /resume

Load a previously saved bookmark and present a structured briefing of where you left off. Designed for session continuity.

## Behavior

When invoked, you (the lead agent) perform the following:

### 1. Find the Bookmark

- If a name is provided, query `records_list` with tag `bookmark:<name>` (status: active)
- If no name is provided, query `records_list` with tag `bookmark` (status: active), show available bookmarks, and ask the user to choose
- If not found, report: "Bookmark '<name>' not found. Use `/bookmark list` to see available bookmarks."

### 2. Load the Bookmark

- Call `records_fetch_content` on the record ID
- Parse the JSON payload

### 3. Staleness Detection

- Run `git branch --show-current` — compare with bookmark's `branch`
- If on the same branch: run `git rev-parse --short HEAD` — compare with bookmark's `commit`. If different, run `git log --oneline <bookmark-commit>..HEAD` to count new commits since bookmark
- If on a different branch: note the divergence
- For each task in `open_tasks`: call `tasks_get` to check current status. Flag any that changed (completed, cancelled, etc.)

### 4. Present the Briefing

Output the following structure:

```
## Resuming: <name>

**Saved:** <created_at>
**Branch:** <branch> (commit <commit>: "<commit_message>")

### Branch Status
<"You are on this branch, at the bookmarked commit" | "You are on <current-branch>, bookmark was on <branch>" | "Branch has advanced: <N> new commits since bookmark">

### Uncommitted Changes at Save Time
<file list from dirty_files, or "Working tree was clean">

### In-Progress Tasks
<task list with current status — flag any that changed since bookmark>

### Recent Snapshots
<snapshot list with IDs for reference>

### Next Steps
<next_steps field from bookmark>
```

### 5. Branch Guidance

If the current branch differs from the bookmark's branch, suggest:
"To switch to the bookmarked branch: `git checkout <branch>`"

### 6. Task Guidance

If there are in-progress tasks, suggest:
"To resume execution: `/reengage <task-id>`"

## Important

- This is a **lead-executed** skill — no drone dispatch needed
- Do **not** auto-checkout branches — report state and let the user decide
- Do **not** modify brain tasks — just report their current status vs saved status

## Usage

```
/resume [name]
```

## Examples

```
/resume auth-refactor
/resume
```

If no name is given, lists available bookmarks and prompts the user to choose.
