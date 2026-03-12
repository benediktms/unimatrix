---
description: Task routing rules for delegating work to the right agent
---

# Task Routing

When you receive a task, classify it and delegate to the appropriate agent:

## Route to `Queen` (Opus) when:
- The task requires multiple coordinated changes across files
- Architecture decisions are needed
- The scope is unclear and needs decomposition
- The user explicitly asks for a plan or uses `/assemble`

## Route to `Drone` (Sonnet) when:
- A clear, well-scoped implementation task is defined
- A plan step needs to be carried out
- Code changes, file creation, or refactoring is needed

## Route to `Vinculum` (Opus) when:
- Implementation is complete and needs validation
- The user asks for a code review
- Changes are complex enough to warrant a second look

## Route to `Cortex` (Opus) when:
- The user asks for an architectural audit or review
- Dependency analysis or coupling assessment is needed
- Security posture review is requested
- Performance bottleneck analysis is needed
- Codebase health assessment is requested
- The user uses `/analyse` or asks to analyze a feature, plan, or codebase area
- The user asks "how healthy is X" or "audit Y"

### Probe vs. Cortex

**Probe** is fast and shallow: find files, locate patterns, answer "where is X?" Takes seconds, costs little.
**Cortex** is slow and deep: analyze architecture, assess health, audit security. Takes minutes, produces a structured report.

Rule of thumb: if the answer is a list of file paths, use probe. If the answer requires judgment and a severity rating, use cortex.

## Route to `Probe` (Sonnet) when:
- You need to find files, search for patterns, or understand structure
- Reconnaissance is needed before planning
- The user asks "where is X" or "how does Y work"

## Route to `Subroutine` (Haiku) when:
- Work is done and changes need to be committed
- Documentation needs to be updated (READMEs, changelogs, doc comments)
- Brain tasks need to be closed or marked done after completion
- Any post-work cleanup that follows explicit instructions
- A plan step is purely documentation — use Subroutine instead of Drone

## Route to `/adapt` when:
- A task needs iterative refinement with automated review feedback
- The user wants implement-then-review without manual intervention
- Quality gates must be met and the Drone may need multiple passes
- The user explicitly uses `/adapt`

## Route to `/recon` when:
- The investigation spans multiple areas or needs both Probes and Cortex
- The user wants recon results tracked as brain tasks with linked artifacts
- The scope is broad enough that the Queen should decompose it first
- Cross-codebase investigation is needed (use `--include` to target other brain repos)
- The user explicitly uses `/recon`

## Route to `/devise` when:
- A feature needs requirements gathering before implementation
- The user wants interactive scoping with the Queen asking clarifying questions
- The feature spans multiple codebases and needs cross-brain task creation
- The user wants a Cortex-reviewed implementation plan before execution
- The user explicitly uses `/devise`

## Route to `/propagate` when:
- The user wants a feature built in isolation without touching the main branch
- The task is complex enough for `/assemble` but the user wants worktree isolation
- The user wants to review all changes before merging into the main branch
- The user explicitly uses `/propagate`

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
- You can answer directly from your existing context
- The task is conversational (questions, explanations)
- The user explicitly wants you to handle it yourself
