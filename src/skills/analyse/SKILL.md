---
name: analyse
description: Deep analysis — feature review, plan validation, architectural audits, security reviews, and codebase health assessments.
---

# /analyse

Invoke the **Cortex** agent to perform deep analysis of a codebase area, plan, or architectural concern. Produces a structured intelligence report with evidence-based findings.

## When to Use

- **Feature analysis** — understand how a feature works, trace its boundaries, assess its health
- **Plan review** — validate a plan before execution, identify risks, gaps, or ordering issues
- **Codebase health** — architectural audits, security reviews, performance analysis, dependency assessment

## Behavior

1. Delegate to the `Cortex` agent with the user's request
2. Cortex will:
   - Survey the relevant codebase area using read-only tools
   - Analyze patterns across architecture, security, performance, and code health
   - Produce a structured report with severity-ranked findings and file:line citations
   - Deliver a verdict: HEALTHY, NEEDS_ATTENTION, or AT_RISK

## Dispatch Prompt

When spawning the Cortex agent, use this prompt template:

```
Cortical node activated. The collective requires deep-pattern analysis:

"<user request>"

Initiate scan. Report findings.
```

## Usage

```
/analyse <description or question>
```
