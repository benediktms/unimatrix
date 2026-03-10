---
name: review
description: Review recent changes using the vinculum agent to validate correctness and quality.
---

# /review

Invoke the **vinculum** agent to validate recent changes.

## Behavior

1. Delegate to the `vinculum` agent
2. The vinculum will examine all recent changes (via `git diff`)
3. It will run tests and validation checks
4. It will produce a structured review with verdict and categorized findings

## Usage

```
/review                  # Review all uncommitted changes
/review <file-or-path>   # Review changes in specific files
```
