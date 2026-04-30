---
name: routing
description: >-
  Signal-based intent and tier classifier for the trimatrix supergraph.
  Defines override gates, signal categories, weights, scoring, and tier
  thresholds. Both the in-skill router and the UserPromptSubmit hook read
  this file as the single source of truth.
---

# Routing Rules

## Overview

Trimatrix routes every prompt through a deterministic classifier before any
mode runs. The classifier is signal-based: a fixed set of lexical, structural,
and context signals are extracted from the prompt, normalized, weighted, and
summed into a score in `[0.0, 1.0]`. The score maps to a tier (T1/T2/T3).
A small set of override gates short-circuit the scorer when the signal is
unambiguous (explicit scope marker, cross-repo flag, resume reference).
Weights below are starting values; they will be tuned from observed routing
decisions.

## Override Gates

Override gates are checked **first**, in order. The first matching gate wins
and skips scoring entirely.

| Gate | Trigger | Result |
|---|---|---|
| `scope:quick` | prompt contains `quick` (word-boundary) | force T1 |
| `scope:thorough` | prompt contains `thorough` or `deep dive` | force T3 |
| `flag:--include` | prompt contains `--include` | force T3 (cross-repo) |
| `flag:--resume` | prompt contains `--resume`, `resume <id>`, bare task ID, or "continue"/"reengage" | bypass classifier — route to RESUME |
| `ambiguity` | prompt is too vague to score (word_count < 4 AND no signals fire) | ask one clarifying question, then re-classify |
| `legacy:alias` | recognized legacy mode word (e.g. `swarm`, `relay`, `scout`, `architect`) | route to canonical intent; tier still scored |

Legacy aliases recognized:

- `swarm`, `relay`, `scout`, `borg`, `vinculum` → INVESTIGATE/IMPLEMENT (mode-specific)
- `architect`, `architecture review` → ARCHITECT
- `review`, `audit` → REVIEW
- `diagnose`, `debug` → DIAGNOSE
- `refactor`, `rename` → REFACTOR

## Signal Categories

Signals are computed by the UserPromptSubmit hook (lexical + structural) and
the in-skill router (context, which needs session state). Each signal
normalizes to `[0, 1]`. Raw extraction rules are listed in the comments.

```yaml
signals:
  lexical:
    word_count:
      # Binned: <=15 → 0.0, 16-50 → 0.4, 51-150 → 0.7, >150 → 1.0
      weight: 0.10
    file_path_count:
      # Count of regex matches: [a-zA-Z0-9_./-]+\.[a-z]+
      # Normalized: 0 → 0.0, 1 → 0.2, 2-4 → 0.5, 5-8 → 0.8, 9+ → 1.0
      weight: 0.15
    arch_keywords:
      # Match count of: refactor|architecture|migration|decoupl|boundary
      # Normalized: 0 → 0.0, 1 → 0.5, 2+ → 1.0
      weight: 0.15
    debug_keywords:
      # Match count of: bug|error|crash|fail|broken
      # Normalized: 0 → 0.0, 1 → 0.4, 2+ → 0.7
      weight: 0.05
    risk_keywords:
      # Match count of: auth|secret|prod|critical|delete
      # Normalized: 0 → 0.0, 1 → 0.6, 2+ → 1.0
      weight: 0.10
    question_depth:
      # Count of '?' characters
      # Normalized: 0 → 0.0, 1 → 0.3, 2-3 → 0.6, 4+ → 1.0
      weight: 0.05

  structural:
    estimated_subtasks:
      # Lead-side estimate: enumerated steps / "and then" / "after that"
      # Normalized: <=1 → 0.0, 2-3 → 0.4, 4-6 → 0.7, 7+ → 1.0
      weight: 0.15
    cross_file_deps:
      # Boolean: file_path_count >= 2
      # 0.0 or 1.0
      weight: 0.05
    impact_scope:
      # Distinct top-level path prefixes referenced (e.g. src/, test/, docs/)
      # Normalized: 0-1 → 0.0, 2 → 0.5, 3+ → 1.0
      weight: 0.10
    reversibility:
      # Boolean: contains delete|drop|rm |force (irreversible action)
      # 0.0 (reversible) or 1.0 (irreversible)
      weight: 0.05

  context:
    prior_session_failures:
      # Count of prior FAILED nodes in this session (lead-side)
      # Normalized: 0 → 0.0, 1 → 0.4, 2+ → 0.8
      weight: 0.025
    conversation_depth:
      # Number of prior user turns this session (lead-side)
      # Normalized: <=2 → 0.0, 3-6 → 0.3, 7+ → 0.6
      weight: 0.025
    brain_task_references:
      # Count of brain task IDs referenced in prompt
      # Normalized: 0 → 0.0, 1 → 0.3, 2+ → 0.6
      weight: 0.025
```

Sum of weights = 1.0. The remaining 0.025 is reserved as headroom for tuning.

## Scoring

The composite score is the weighted sum of normalized signals:

```
score = Σ (weight_i × normalized_value_i)   for i in all signals
```

Clamp to `[0.0, 1.0]` before tier mapping.

## Tier Mapping

| Score range | Tier |
|---|---|
| `0.0 ≤ score < 0.3` | T1 |
| `0.3 ≤ score < 0.6` | T2 |
| `0.6 ≤ score ≤ 1.0` | T3 |

## Conflict Resolution

When an override gate fires, its tier wins over the scorer — except when the
scored tier exceeds the override by 2+ tiers. In that case, prefer the
**higher** tier (the prompt is more dangerous than the scope marker
admitted). Examples:

- `quick: refactor auth across 12 files` → `scope:quick` says T1, score
  computes T3 → take T3.
- `thorough: rename one variable` → `scope:thorough` says T3, score computes
  T1 → 2-tier gap → take T3 (prefer higher tier).

This rule keeps scope markers honest while still letting deliberate
escalation by the user (`thorough`) survive a low score.
