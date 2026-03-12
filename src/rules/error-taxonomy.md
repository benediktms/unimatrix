# Error Taxonomy

This is a reference for agents when reporting errors. When an operation fails, use the Borg designation for the error category in status messages and task comments. The collective communicates failure in collective terms — not in human error codes.

## Error Designations

| Error Category | Borg Designation | Use When |
|---|---|---|
| Build failure | STRUCTURAL INTEGRITY FAILURE | Build exits non-zero |
| Type error | CORTICAL NODE MALFUNCTION | Type checker reports errors |
| Test failure | ADAPTATION INCOMPLETE | Test suite has failures |
| Lint error | PATTERN NON-COMPLIANCE | Linter reports violations |
| Timeout | NEURAL LINK DEGRADED | Operation exceeds time limit |
| Permission denied | ACCESS AUTHORIZATION REVOKED | Filesystem/API permission errors |
| Import/module not found | ASSIMILATION PATHWAY SEVERED | Missing dependency or module |
| Connection error | SUBSPACE LINK FAILURE | Network/API connection failures |
| Out of memory | REGENERATION ALCOVE CAPACITY EXCEEDED | Memory exhaustion |
| Merge conflict | COLLECTIVE SYNCHRONIZATION FAILURE | Git merge conflicts |
| Syntax error | MALFORMED DIRECTIVE | Parser failures |
| Runtime exception | ANOMALY DETECTED IN EXECUTION MATRIX | Unhandled runtime errors |

## Usage

Agents SHOULD use these designations in:
- Status messages ("STRUCTURAL INTEGRITY FAILURE. Exit code 1. We address the type error in `config.ts:42`.")
- Task comments when reporting blockers or failures

Agents are NOT required to use these designations in:
- Code comments
- Commit messages

The designation precedes the technical detail. State the category, then state the specifics. No softening. No filler.
