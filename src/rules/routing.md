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

Trimatrix routes every prompt through a deterministic classifier before any mode
runs. The classifier is signal-based: a fixed set of lexical, structural, and
context signals are extracted from the prompt, normalized, weighted, and summed
into a score in `[0.0, 1.0]`. The score maps to a tier (T1/T2/T3). A small set
of override gates short-circuit the scorer when the signal is unambiguous
(explicit scope marker, cross-repo flag, resume reference). Weights below are
starting values; they will be tuned from observed routing decisions.

## Override Gates

Override gates are checked **first**, in order. The first matching gate wins and
skips scoring entirely.

<override-gates evaluation="first-match-wins">
  <gate name="scope:quick" result="force T1">
    <trigger>prompt contains `quick` (word-boundary)</trigger>
  </gate>
  <gate name="scope:thorough" result="force T3">
    <trigger>prompt contains `thorough` or `deep dive`</trigger>
    <note>
      `deep dive` also appears in `&lt;formation-aliases&gt;` as a `/recon-sphere`
      trigger. Both fire — `scope:thorough` (override gate) sets the tier
      to T3, and the formation alias routes the skill to `/recon-sphere`.
      The two are orthogonal: tier comes from the override gate, skill
      comes from formation routing. No conflict.
    </note>
  </gate>
  <gate name="flag:--include" result="force T3 (cross-repo)">
    <trigger>prompt contains `--include`</trigger>
  </gate>
  <gate name="intent:cross-repo" result="force T3 (cross-repo)">
    <trigger>
      `cross_repo_hint` signal from the UserPromptSubmit hook is `true`
      (matched the `MULTI_REPO_PHRASE_RE` regex), OR the in-skill router
      resolves ≥2 distinct brain IDs/aliases from the prompt via
      `mcp__unimatrix__resolve_brains`
    </trigger>
    <effect>treated identically to `--include` — forces T3, activates
      Locutus Protocol planning, opens neural-link room with `brains`
      parameter populated</effect>
  </gate>
  <gate name="flag:--resume" result="bypass classifier — route to RESUME">
    <trigger>prompt contains `--resume`, `resume <id>`, bare task ID, or `continue` / `reengage`</trigger>
  </gate>
  <gate name="ambiguity" result="ask one clarifying question, then re-classify">
    <trigger>prompt is too vague to score (`word_count < 4` AND no signals fire)</trigger>
  </gate>
  <gate name="legacy:alias" result="route to canonical intent; tier still scored">
    <trigger>recognized legacy mode word (e.g. `swarm`, `relay`, `scout`, `architect`)</trigger>
  </gate>
</override-gates>

<legacy-aliases>
  <alias word="swarm,relay,scout,borg,vinculum" intent="INVESTIGATE | IMPLEMENT (mode-specific)"/>
  <alias word="architect,architecture review" intent="ARCHITECT"/>
  <alias word="review,audit" intent="REVIEW"/>
  <alias word="diagnose,debug" intent="DIAGNOSE"/>
  <alias word="refactor,rename" intent="REFACTOR"/>
</legacy-aliases>

<formation-aliases>
  <!-- Named-formation triggers route directly to the wrapping skill,
       which owns tier selection and gate enforcement. The
       UserPromptSubmit hook sets `formation_hint` from the same regexes;
       both paths converge on the same skill.

       Formation routing BYPASSES the scorer — `formation_hint` is an
       override-gate-equivalent signal, not a scored signal. It does NOT
       appear in the <signals> block below; the scoring weight sum
       remains 0.975 unaffected. -->
  <!-- DRIFT WARNING: each <alias word="..."> entry below MUST stay in
       sync with the matching FORMATION_*_RE in
       src/hooks/claude/route-classify.py. The hook regex set is the
       authoritative implementation; this file is the documented surface
       users read. Divergence between the two is a latent routing bug. -->
  <alias
    word="compliance matrix,compliance check,compliance review,sentinel,sentinel review,sentinel pass,sentinel gate,quality gate,quality check,pre-merge audit,PR review,code review,validate,verify,evaluate,assess,second opinion,sanity check,is this safe,look for bugs"
    formation="/compliance-sphere"
    intent="REVIEW"/>
  <alias
    word="vinculum,vinculum review,vinculum analysis,analyze,analysis,investigate,investigation,deep dive,trace,trace through,map,map out,where is,where are,locate,understand,explore,scout,relay,designate"
    formation="/recon-sphere"
    intent="INVESTIGATE"/>
  <alias
    word="borg cube,build team,agent team,agent teams,parallel implementation,parallel build,tackle this in parallel,tackle this epic in parallel,epic team,implementation team,decompose and build"
    formation="/fabrication-cube"
    intent="IMPLEMENT"/>
  <ambiguous
    word="borg sphere"
    note="size descriptor, not formation-specific. Resolve via scope signals: research → /recon-sphere; review → /compliance-sphere; build → /fabrication-cube. Fire ambiguity gate if no signal disambiguates."/>
</formation-aliases>

## Signal Categories

Signals are computed by the UserPromptSubmit hook (lexical + structural) and the
in-skill router (context, which needs session state). Each signal normalizes to
`[0, 1]`.

<signals total-weight="0.975" headroom="0.025">
  <category name="lexical">
    <signal name="word_count" weight="0.10">
      <extract>Count whitespace-separated tokens in the prompt.</extract>
      <bin range="<=15" value="0.0"/>
      <bin range="16-50" value="0.4"/>
      <bin range="51-150" value="0.7"/>
      <bin range=">150" value="1.0"/>
    </signal>
    <signal name="file_path_count" weight="0.15">
      <extract>Count regex matches: `[a-zA-Z0-9_./-]+\.[a-z]+`</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.2"/>
      <bin range="2-4" value="0.5"/>
      <bin range="5-8" value="0.8"/>
      <bin range="9+" value="1.0"/>
    </signal>
    <signal name="arch_keywords" weight="0.15">
      <extract>Match count of: `refactor|architecture|migration|decoupl|boundary`</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.5"/>
      <bin range="2+" value="1.0"/>
    </signal>
    <signal name="debug_keywords" weight="0.05">
      <extract>Match count of: `bug|error|crash|fail|broken`</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.4"/>
      <bin range="2+" value="0.7"/>
    </signal>
    <signal name="risk_keywords" weight="0.10">
      <extract>Match count of: `auth|secret|prod|critical|delete`</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.6"/>
      <bin range="2+" value="1.0"/>
    </signal>
    <signal name="question_depth" weight="0.05">
      <extract>Count of `?` characters.</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.3"/>
      <bin range="2-3" value="0.6"/>
      <bin range="4+" value="1.0"/>
    </signal>
  </category>

<category name="structural">
    <signal name="estimated_subtasks" weight="0.15">
      <extract>Lead-side estimate: enumerated steps / "and then" / "after that".</extract>
      <bin range="<=1" value="0.0"/>
      <bin range="2-3" value="0.4"/>
      <bin range="4-6" value="0.7"/>
      <bin range="7+" value="1.0"/>
    </signal>
    <signal name="cross_file_deps" weight="0.025">
      <extract>Boolean: `file_path_count >= 2`.</extract>
      <bin value="0.0 (false)"/>
      <bin value="1.0 (true)"/>
    </signal>
    <signal name="impact_scope" weight="0.10">
      <extract>Distinct top-level path prefixes referenced (e.g. `src/`, `test/`, `docs/`).</extract>
      <bin range="0-1" value="0.0"/>
      <bin range="2" value="0.5"/>
      <bin range="3+" value="1.0"/>
    </signal>
    <signal name="reversibility" weight="0.025">
      <extract>Boolean: contains `delete|drop|rm |force` (irreversible action).</extract>
      <bin value="0.0 (reversible)"/>
      <bin value="1.0 (irreversible)"/>
    </signal>
    <signal name="cross_repo_signal" weight="0">
      <!-- Diagnostic only. The override gate `intent:cross-repo` consumes
           the same hook-computed `cross_repo_hint` and short-circuits
           scoring; this entry documents the signal for observability and
           parity with `cross_file_deps`. -->
      <extract>Boolean: hook-computed `cross_repo_hint` from `MULTI_REPO_PHRASE_RE`, OR ≥2 distinct brain IDs/aliases resolved from the prompt.</extract>
      <bin value="0.0 (single-repo)"/>
      <bin value="1.0 (cross-repo)"/>
    </signal>
  </category>

<category name="context">
    <signal name="prior_session_failures" weight="0.025">
      <extract>Count of prior FAILED nodes in this session (lead-side).</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.4"/>
      <bin range="2+" value="0.8"/>
    </signal>
    <signal name="conversation_depth" weight="0.025">
      <extract>Number of prior user turns this session (lead-side).</extract>
      <bin range="<=2" value="0.0"/>
      <bin range="3-6" value="0.3"/>
      <bin range="7+" value="0.6"/>
    </signal>
    <signal name="brain_task_references" weight="0.025">
      <extract>Count of brain task IDs referenced in prompt.</extract>
      <bin range="0" value="0.0"/>
      <bin range="1" value="0.3"/>
      <bin range="2+" value="0.6"/>
    </signal>
  </category>
</signals>

Sum of enumerated weights = 0.975. Reserved headroom = 0.025. Combined budget =
1.0.

## Scoring

The composite score is the weighted sum of normalized signals:

```
score = Σ (weight_i × normalized_value_i)   for i in all signals
```

Clamp to `[0.0, 1.0]` before tier mapping.

## Tier Mapping

<tier-mapping>
  <tier name="T1" range="0.0 ≤ score < 0.3"/>
  <tier name="T2" range="0.3 ≤ score < 0.6"/>
  <tier name="T3" range="0.6 ≤ score ≤ 1.0"/>
</tier-mapping>

## Conflict Resolution

<conflict-resolution>
  <rule>
    When an override gate fires, its tier wins over the scorer — except when
    the scored tier exceeds the override by 2+ tiers. In that case, prefer the
    **higher** tier (the prompt is more dangerous than the scope marker admitted).
  </rule>
  <example>
    <prompt>`quick: refactor auth across 12 files`</prompt>
    <override>scope:quick → T1</override>
    <score>computes T3</score>
    <decision>take T3 (2-tier gap)</decision>
  </example>
  <example>
    <prompt>`thorough: rename one variable`</prompt>
    <override>scope:thorough → T3</override>
    <score>computes T1</score>
    <decision>take T3 (prefer higher tier; deliberate escalation survives)</decision>
  </example>
  <rationale>
    Keeps scope markers honest while letting deliberate escalation by the user
    (`thorough`) survive a low score.
  </rationale>
</conflict-resolution>
