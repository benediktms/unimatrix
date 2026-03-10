---
name: review
description: Review recent changes using the adjunct agent to validate correctness and quality.
---

# /review

Invoke the **adjunct** agent to validate recent changes.

## Behavior

1. Delegate to the `adjunct` agent
2. The adjunct will examine all recent changes (via `git diff`)
3. It will run tests and validation checks
4. It will produce a structured review with verdict and categorized findings

## Usage

```
/review                  # Review all uncommitted changes
/review <file-or-path>   # Review changes in specific files
```
