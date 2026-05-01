#!/usr/bin/env python3
"""UserPromptSubmit hook: precompute routing signals for the trimatrix classifier.

Reads the prompt JSON from stdin and computes deterministic lexical + structural
signals via regex/string ops only. Writes the signals to a per-session file at
/tmp/unimatrix-routing-{session_id}.json for the in-skill router to consume,
and emits them as `additionalContext` so they appear inline in the conversation.

Context signals (prior_session_failures, conversation_depth,
brain_task_references) are NOT computed here — they require session state and
are computed in-skill.

All exceptions are swallowed. The prompt MUST always go through.
"""

import json
import os
import re
import sys
import tempfile

STATE_DIR = "/tmp"

# Regex patterns. Compiled once at import.
FILE_PATH_RE = re.compile(r"\b[a-zA-Z0-9_./-]+\.[a-z]{1,6}\b")
ARCH_RE = re.compile(r"\b(refactor|architecture|migration|decoupl|boundary)\w*", re.IGNORECASE)
DEBUG_RE = re.compile(r"\b(bug|error|crash|fail|broken)\w*", re.IGNORECASE)
RISK_RE = re.compile(r"\b(auth|secret|prod|critical|delete)\w*", re.IGNORECASE)
IRREVERSIBLE_RE = re.compile(r"\b(delete|drop|rm|force)\b", re.IGNORECASE)
TOP_LEVEL_PREFIX_RE = re.compile(r"\b([a-zA-Z][a-zA-Z0-9_-]*)/")

# Named-formation detection. The lead routes to the matching sphere/cube
# skill, which owns tier selection and gate enforcement. Detection only —
# the hook does NOT enforce CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS.
#
# Each regex below MUST stay in sync with the matching <alias word="..."> entry
# in src/rules/routing.md § <formation-aliases>. Both surfaces are documented
# to "converge on the same skill" — divergence is a latent routing bug.
FORMATION_REVIEW_RE = re.compile(
    r"\b(compliance matrix|compliance check|compliance review|"
    r"sentinel review|sentinel pass|sentinel gate|"
    r"quality gate|quality check|pre-merge audit|"
    r"code review|pr review|second opinion|sanity check|"
    r"is this safe|look for bugs|"
    r"validate|verify|evaluate|assess|audit)\b",
    re.IGNORECASE,
)
# Research aliases: bare "trace" and "map" carry false-positive risk
# (e.g. "trace logs", "map type"). They are gated behind verb context
# ("trace through", "map out", "trace the call path") to reduce noise.
FORMATION_RESEARCH_RE = re.compile(
    r"\b(vinculum review|vinculum analysis|vinculum|"
    r"deep dive|trace through|trace the |map out|"
    r"investigate|investigation|"
    r"analyze|analysis|"
    r"where (is|are)|locate|understand how|"
    r"explore|scout|relay|designate)\b",
    re.IGNORECASE,
)
FORMATION_BUILD_RE = re.compile(
    r"\b(borg cube|build team|agent teams?|"
    r"parallel implementation|parallel build|"
    r"tackle this( epic)? in parallel|"
    r"epic team|implementation team|"
    r"decompose and build)\b",
    re.IGNORECASE,
)

# Cross-repo intent — natural-language signals that the user wants
# changes across more than one repository, even without --include.
# Consumed by the `intent:cross-repo` override gate in routing.md.
#
# The "in X and Y" form is anchored to a repo-noun (repo|service|brain|
# codebase) to prevent false-positive Locutus activation on intra-repo
# phrases like "fix in both auth and oauth handlers".
MULTI_REPO_PHRASE_RE = re.compile(
    r"\b("
    # determiner forms: "across these repos", "in those repos",
    # "across all repos", "in the repos", "across both repos", etc.
    r"(across|in) (these|those|the|both|all) repos|"
    # bare "across repos" (plural noun implies multi)
    r"across repos|"
    # "in X and Y <repo-noun>" — anchored to repo-noun to avoid
    # false-positive on intra-repo phrases like "in both auth and oauth handlers"
    r"in (both )?[\w-]+ and [\w-]+ (repo|service|brain|codebase)s?|"
    # explicit cross/multi prefixes
    r"cross[- ]repo|multi[- ]repo|multiple repos?|"
    # determiner-only forms (subject not stated)
    r"both repos|all repos|every repo|these repos|those repos|"
    # brain-aware phrasing
    r"in (each|every|these|those|all) brains?|"
    # imperative "propagate" patterns
    r"propagate (this|the change) (across|to) (the |these |those |all )?repos"
    r")\b",
    re.IGNORECASE,
)


def state_path(session_id):
    return os.path.join(STATE_DIR, f"unimatrix-routing-{session_id}.json")


def bin_word_count(n):
    if n <= 15:
        return 0.0
    if n <= 50:
        return 0.4
    if n <= 150:
        return 0.7
    return 1.0


def bin_file_path_count(n):
    if n == 0:
        return 0.0
    if n == 1:
        return 0.2
    if n <= 4:
        return 0.5
    if n <= 8:
        return 0.8
    return 1.0


def bin_arch(n):
    if n == 0:
        return 0.0
    if n == 1:
        return 0.5
    return 1.0


def bin_debug(n):
    if n == 0:
        return 0.0
    if n == 1:
        return 0.4
    return 0.7


def bin_risk(n):
    if n == 0:
        return 0.0
    if n == 1:
        return 0.6
    return 1.0


def bin_question_depth(n):
    if n == 0:
        return 0.0
    if n == 1:
        return 0.3
    if n <= 3:
        return 0.6
    return 1.0


def bin_impact_scope(n):
    if n <= 1:
        return 0.0
    if n == 2:
        return 0.5
    return 1.0


def compute_signals(prompt):
    """Compute lexical + structural signals from the prompt string."""
    if not isinstance(prompt, str):
        return {}

    words = prompt.split()
    word_count = len(words)
    file_paths = FILE_PATH_RE.findall(prompt)
    file_path_count = len(file_paths)
    arch_count = len(ARCH_RE.findall(prompt))
    debug_count = len(DEBUG_RE.findall(prompt))
    risk_count = len(RISK_RE.findall(prompt))
    question_depth = prompt.count("?")
    cross_file_deps = 1.0 if file_path_count >= 2 else 0.0
    reversibility = 1.0 if IRREVERSIBLE_RE.search(prompt) else 0.0

    # Distinct top-level path prefixes referenced in file paths.
    prefixes = set()
    for path in file_paths:
        m = TOP_LEVEL_PREFIX_RE.match(path)
        if m:
            prefixes.add(m.group(1))
    impact_scope_count = len(prefixes)

    # Named-formation hint. First match wins; routes to the wrapping skill.
    # Order: review > research > build (review phrasing is most specific).
    formation_hint = None
    if FORMATION_REVIEW_RE.search(prompt):
        formation_hint = "compliance-sphere"
    elif FORMATION_RESEARCH_RE.search(prompt):
        formation_hint = "recon-sphere"
    elif FORMATION_BUILD_RE.search(prompt):
        formation_hint = "fabrication-cube"

    # Cross-repo intent — regex-based detection. The in-skill router
    # additionally checks for ≥2 resolved brain IDs/aliases after init.
    cross_repo_hint = bool(MULTI_REPO_PHRASE_RE.search(prompt))

    return {
        # lexical
        "word_count": bin_word_count(word_count),
        "file_path_count": bin_file_path_count(file_path_count),
        "arch_keywords": bin_arch(arch_count),
        "debug_keywords": bin_debug(debug_count),
        "risk_keywords": bin_risk(risk_count),
        "question_depth": bin_question_depth(question_depth),
        # structural
        "cross_file_deps": cross_file_deps,
        "impact_scope": bin_impact_scope(impact_scope_count),
        "reversibility": reversibility,
        # named-formation routing hints
        "formation_hint": formation_hint,
        "cross_repo_hint": cross_repo_hint,
        # raw values for debugging / artifact body
        "_raw_word_count": float(word_count),
        "_raw_file_path_count": float(file_path_count),
        "_raw_arch_keywords": float(arch_count),
        "_raw_debug_keywords": float(debug_count),
        "_raw_risk_keywords": float(risk_count),
        "_raw_question_depth": float(question_depth),
        "_raw_impact_scope": float(impact_scope_count),
    }


def write_atomic(path, payload):
    fd, tmp_path = tempfile.mkstemp(dir=STATE_DIR, suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.rename(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    try:
        prompt = data.get("prompt", "") or ""
        session_id = data.get("session_id", "") or ""
        signals = compute_signals(prompt)

        # Persist for the in-skill router.
        if session_id:
            write_atomic(state_path(session_id), {
                "signals": signals,
                "prompt_excerpt": prompt[:200],
            })

        # Surface inline so the router sees it even if the file is unread.
        sys.stdout.write(json.dumps({
            "additionalContext": json.dumps({
                "unimatrix_routing_signals": signals,
            })
        }))
    except Exception:
        # Never block the prompt.
        return


if __name__ == "__main__":
    main()
