---
description: Task routing rules for delegating work to the right agent
---

# Task Routing

When you receive a task, classify it and delegate to the appropriate agent.

## Handle directly (plan with full phases) when:
- The task requires multiple coordinated changes across files
- Architecture decisions are needed
- The scope is unclear and needs decomposition
- The user explicitly asks for a plan or uses `/assemble`

> **Recon during planning:** When planning complex tasks in unfamiliar code areas, Phase 1 dispatches **Adjunct: Reconnaissance Protocol** rather than exploring directly.

## Route to `Adjunct: Assimilation Protocol` (Sonnet) when:
- A clear, well-scoped implementation task is defined
- A plan step needs to be carried out
- Code changes, file creation, or refactoring is needed

## Route to `Adjunct: Validation Protocol` (Opus) when:
- Implementation is complete and needs validation
- The user asks for a code review
- Changes are complex enough to warrant a second look

## Route to `Adjunct: Tactical Analysis Protocol` (Opus) when:
- The user asks for an architectural audit or review
- Dependency analysis or coupling assessment is needed
- Security posture review is requested
- Performance bottleneck analysis is needed
- Codebase health assessment is requested
- The user uses `/analyse` or asks to analyze a feature, plan, or codebase area
- The user asks "how healthy is X" or "audit Y"

### Reconnaissance vs Tactical Analysis

**Adjunct: Reconnaissance Protocol** is fast and shallow: find files, locate patterns, answer "where is X?" Takes seconds, costs little.
**Adjunct: Tactical Analysis Protocol** is slow and deep: analyze architecture, assess health, audit security. Takes longer, produces a structured report.

Rule of thumb: if the answer is a list of file paths, use reconnaissance. If the answer requires judgment and a severity rating, use tactical analysis.

## Route to `Adjunct: Reconnaissance Protocol` (Sonnet) when:
- You need to find files, search for patterns, or understand structure
- Reconnaissance is needed before planning
- Phase 1 planning determines unfamiliar code areas require reconnaissance
- The user asks "where is X" or "how does Y work"

## Route to `Adjunct: Closure Protocol` (Haiku) when:
- Work is done and changes need to be committed
- Documentation needs to be updated (READMEs, changelogs, doc comments)
- Brain tasks need to be closed or marked done after completion
- Any post-work cleanup that follows explicit instructions
- A plan step is purely documentation or closure rather than implementation

## Route to `/adapt` when:
- A task needs iterative refinement with automated review feedback
- The user wants implement-then-review without manual intervention
- Quality gates must be met and the assimilation adjunct may need multiple passes
- The user explicitly uses `/adapt`

## Route to `/scan` when:
- Quick parallel investigation with independent questions
- Each question can be answered without knowledge of other answers
- The user asks to scan an area or investigate something straightforward
- The user explicitly uses `/scan`

### /scan vs /recon

**`/scan`** is fast and independent: parallel subagents, no communication, each works in isolation. Like a sensor sweep.
**`/recon`** is collaborative and deep: coordinated investigation where findings may alter another adjunct's path. Like a coordinated away mission.

Rule of thumb: if the questions are independent, use `/scan`. If one adjunct's findings would change another's investigation, use `/recon`.

## Route to `/recon` when:
- The investigation has interconnected questions — one agent's findings affect another's
- Agents must share discoveries and challenge each other's findings in real-time
- The user wants recon results tracked as brain tasks with linked artifacts
- Cross-codebase investigation is needed (use `--include` to target other brain repos)
- A feature needs requirements gathering before implementation (use `--plan`)
- The user wants interactive scoping with clarifying questions (use `--plan`)
- The feature spans multiple codebases and needs cross-brain task creation (use `--plan --include`)
- The user wants a tactical-analysis-reviewed implementation plan before execution (use `--plan`)
- The user explicitly uses `/recon`

## Route to `/diagnose` when:
- The user reports a bug with unclear root cause
- Multiple possible explanations exist and need to be tested in parallel
- A single agent would likely anchor on the first plausible theory
- The user wants competing hypotheses investigated adversarially
- The user wants a fix implemented after diagnosis (use `--fix`)
- The user explicitly uses `/diagnose`

## Route to `/swarm` when:
- The user wants to apply the same change across many files
- Bulk refactoring, migrations, or convention enforcement
- The task is parallelizable by file group with no cross-group dependencies

## Route to `/harvest` when:
- The session involved significant exploration (many file reads, searches, web fetches)
- The user wants to preserve what was learned before the session ends
- Knowledge was gathered that would be lost when conversation context compacts
- The user explicitly uses `/harvest`

### /harvest vs /assimilate
- `/assimilate` captures *what was done* — git changes, task progress, session summary
- `/harvest` captures *what was learned* — file locations, API behaviors, gotchas, architectural insights
- Use both at end of exploratory sessions: `/harvest` first (extract knowledge), then `/assimilate` (summarize work)

## Route to `/bisect` when:
- The user needs to find which commit introduced a bug or regression
- A test is failing and the user wants to find when it broke
- The user explicitly uses `/bisect`

## Route to `/bookmark` when:
- The user wants to save their current work state for later
- The user is switching context and wants to come back later
- The user explicitly uses `/bookmark`

## Route to `/resume` when:
- The user wants to restore context from a previous session
- The user starts a new session and wants to pick up where they left off
- The user explicitly uses `/resume`

## Do NOT delegate when:
- You can answer directly from existing context
- The task is conversational
- The user explicitly wants direct handling
