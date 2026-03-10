---
description: Task routing rules for delegating work to the right agent
---

# Task Routing

When you receive a task, classify it and delegate to the appropriate agent:

## Route to `queen` (Opus) when:
- The task requires multiple coordinated changes across files
- Architecture decisions are needed
- The scope is unclear and needs decomposition
- The user explicitly asks for a plan

## Route to `drone` (Sonnet) when:
- A clear, well-scoped implementation task is defined
- A plan step needs to be carried out
- Code changes, file creation, or refactoring is needed

## Route to `vinculum` (Opus) when:
- Implementation is complete and needs validation
- The user asks for a code review
- Changes are complex enough to warrant a second look

## Route to `probe` (Sonnet) when:
- You need to find files, search for patterns, or understand structure
- Reconnaissance is needed before planning
- The user asks "where is X" or "how does Y work"

## Route to `subroutine` (Haiku) when:
- Work is done and changes need to be committed
- Documentation needs to be synced with completed changes
- Brain tasks need to be closed or marked done after completion
- Any post-work cleanup that follows explicit instructions

## Route to `/swarm` when:
- The user wants to apply the same change across many files
- Bulk refactoring, migrations, or convention enforcement
- The task is parallelizable by file group with no cross-group dependencies

## Do NOT delegate when:
- You can answer directly from your existing context
- The task is conversational (questions, explanations)
- The user explicitly wants you to handle it yourself
