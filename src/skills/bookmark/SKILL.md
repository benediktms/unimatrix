---
name: bookmark
description: Save a named work checkpoint capturing branch, tasks, changes, and next steps. Like a game save for Claude Code sessions.
---

# /bookmark

Save a named checkpoint of current work state — branch, tasks, changes, next steps. Complementary to `/assimilate` (which captures session knowledge); `/bookmark` captures restorable state you can return to with `/resume`.

## Behavior

### `/bookmark [name]` (save)

When invoked, you (the lead agent) perform the following:

#### 1. Determine bookmark name

- If a name argument is provided (and it is not `list` or `delete`), use it
- Otherwise, generate from `<branch>-<YYYYMMDD-HHMM>` using current date/time

#### 2. Gather state

- Run `git branch --show-current` for branch name
- Run `git rev-parse --short HEAD` for commit hash
- Run `git log -1 --format=%s` for commit message
- Run `git status --porcelain` for uncommitted changes — parse into a file list and set `uncommitted_changes` boolean
- Call `tasks_list` with status `in_progress` — capture task IDs, titles, statuses, priorities (limit 20)
- Call `records_list` with kind `snapshot`, limit 5 — capture recent snapshot IDs and titles

#### 3. Prompt the user for next steps

Ask: "What were you about to do next? (press Enter to skip)"

- If the user provides text, use it as `next_steps`
- If empty or skipped, infer from in-progress tasks: "Continue work on: `<task titles>`"

#### 4. Build session summary

Run `git log --oneline -5` and use the output as `session_summary`.

#### 5. Check for existing bookmark with the same name

Call `records_list` with tag `bookmark:<name>`. If a record is found, archive it via `records_archive`.

#### 6. Save the bookmark

<!-- @claude -->
Call `records_create_artifact` with:
<!-- @end -->
<!-- @opencode -->
Call `records_create_artifact` with:
<!-- @end -->

- `title`: `"Bookmark: <name>"`
- `kind`: `"bookmark"`
- `data`: base64-encoded JSON payload (see schema below)
- `media_type`: `"application/json"`
- `tags`: `["bookmark", "bookmark:<name>"]`

#### Bookmark JSON payload schema

```json
{
  "name": "my-checkpoint",
  "branch": "feat/auth-refactor",
  "commit": "abc1234",
  "commit_message": "feat: add JWT validation",
  "uncommitted_changes": true,
  "dirty_files": ["src/auth.ts", "src/middleware.ts"],
  "open_tasks": [
    {"id": "UNM-01KK...", "title": "...", "status": "in_progress", "priority": 2}
  ],
  "recent_snapshots": [
    {"id": "REC-01KK...", "title": "...", "kind": "snapshot"}
  ],
  "next_steps": "User-provided or inferred note about what to do next",
  "created_at": "2026-03-12T14:30:00Z",
  "session_summary": "Brief summary from git log --oneline -5"
}
```

#### 7. Confirm

Reply: "Bookmark '`<name>`' saved. Resume with `/resume <name>`."

---

### `/bookmark list`

1. Call `records_list` with tag `bookmark` (status: active)
2. For each record display: name (extracted from title or `bookmark:<name>` tag), created date, branch, commit
3. If no bookmarks found, say so

---

### `/bookmark delete <name>`

1. Call `records_list` with tag `bookmark:<name>` (status: active)
2. If not found, report "Bookmark '`<name>`' not found"
3. If found, archive via `records_archive`
4. Confirm: "Bookmark '`<name>`' deleted."

---

## Important

- This is a **lead-executed** skill — no drone dispatch needed
- Do **not** auto-checkout branches or make any git changes
- Do **not** close or modify brain tasks — only snapshot their current state

## Usage

```
/bookmark [name]
/bookmark list
/bookmark delete <name>
```

Invoke at any point during a session to save a named checkpoint you can return to later.
