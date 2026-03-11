---
name: comply
description: Review recent changes using the vinculum agent to validate correctness and quality. You will comply.
---

# /comply

Invoke the **vinculum** agent to validate recent changes. The vinculum applies evidence-based verification — every claim in its review is backed by command output or explicit file:line citations.

## Behavior

1. Determine the review target from the arguments
2. Delegate to the `vinculum` agent with a structured prompt
3. The vinculum will:
   - Load the task and read all changes
   - Select a review tier (Quick / Standard / Deep) based on diff size or task label
   - Run verification commands and capture evidence for each required category
   - Produce a structured review with verdict, evidence table, and categorized findings

## Dispatch Prompt

When spawning the vinculum agent, use this prompt template:

**If a brain task ID is provided:**

```
Vinculum — verification sequence initiated.

Task: <task-id>

Analyze the implementation. Validate against requirements. Collect evidence. Report.
```

**If a file path or no arguments:**

```
Vinculum — verification sequence initiated.

Scope: <file path, or "all uncommitted changes">

Analyze the changes. Validate correctness. Collect evidence. Report.
```

## Usage

```
/comply                    # Review all uncommitted changes
/comply <task-id>          # Review changes for a brain task
/comply <file-or-path>     # Review changes in specific files
```
