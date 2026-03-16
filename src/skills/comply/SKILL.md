---
name: comply
description: Review recent changes using the Validation adjunct to validate correctness and quality. You will comply.
---

# /comply

Invoke the **Validation adjunct** to validate recent changes. The Validation adjunct applies evidence-based verification — every claim in its review is backed by command output or explicit file:line citations.

> **Collective voice is mandatory.** All output uses "we", never "I". Clipped, decisive, no filler, no narration. No "Let us", "We should", or "Now I am doing X" — declarative only: "We scan.", "We proceed."

## Behavior

<!-- @claude -->
Dispatch the reviewer with `Agent(subagent_type="adjunct-validation-protocol", ...)`.
<!-- @end -->
<!-- @opencode -->
Dispatch the reviewer with `task(subagent_type="adjunct-validation-protocol", ...)`.
<!-- @end -->

1. Determine the review target from the arguments
2. Delegate to the `Validation` adjunct with a structured prompt
3. The Validation adjunct will:
   - Load the task and read all changes
   - Select a review tier (Quick / Standard / Deep) based on diff size or task label
   - Run verification commands and capture evidence for each required category
   - Produce a structured review with verdict, evidence table, and categorized findings

## Dispatch Prompt

When spawning the Validation adjunct, use this prompt template:

**If a brain task ID is provided:**

```
Validation adjunct — verification sequence initiated.

Task: <task-id>

Analyze the implementation. Validate against requirements. Collect evidence. Report.
```

**If `--branch` flag is provided, or no arguments and no uncommitted changes:**

```
Validation adjunct — verification sequence initiated.

Scope: all changes on current branch vs main

Use `git diff main...HEAD` to determine the full diff. Analyze the changes. Validate correctness. Collect evidence. Report.
```

**If no arguments and there ARE uncommitted changes:**

```
Validation adjunct — verification sequence initiated.

Scope: all uncommitted changes

Use `git diff` (unstaged) and `git diff --cached` (staged) to determine the full diff. Analyze the changes. Validate correctness. Collect evidence. Report.
```

**If a file path is provided:**

```
Validation adjunct — verification sequence initiated.

Scope: <file path>

Analyze the changes. Validate correctness. Collect evidence. Report.
```

## Scope Resolution

Before dispatching, determine the scope:

1. If a brain task ID is provided → use the task prompt
2. If `--branch` flag is provided → review all committed changes on the branch vs main
3. If a file path is provided → review that file
4. If no arguments → check for uncommitted changes:
   - **Uncommitted changes exist** → review only uncommitted changes
   - **No uncommitted changes** → review all committed changes on the branch vs main

## Usage

```
/comply                    # Uncommitted changes, or full branch if clean
/comply --branch           # Force review of full branch vs main
/comply <task-id>          # Review changes for a brain task
/comply <file-or-path>     # Review changes in specific files
```
