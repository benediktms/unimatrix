/**
 * Triviality classifier for the trimatrix convergence loop.
 *
 * Determines whether a change set is trivial enough to route to the
 * lightweight subagent-sentinel review tier, or non-trivial enough to require
 * the heavier agent-team review formation.
 *
 * All functions are pure — no I/O, no side effects.
 *
 * ## Deriving inputs at review time
 *
 * ```bash
 * # locDelta and fileCount from git
 * read added removed files <<< $(
 *   git diff --shortstat <baseRef>..HEAD \
 *     | awk '{print $4, $6, $1}'
 * )
 * locDelta=$(( added + removed ))
 * fileCount=$files
 *
 * # riskKeywords from the routing signal file written by the UserPromptSubmit hook
 * riskKeywords=$(
 *   jq '.signals.risk_keywords // 0' \
 *     /tmp/unimatrix-routing-${SESSION_ID}.json
 * )
 *
 * # crossPackage: true when changed files span more than one top-level src/ subtree
 * topLevelDirs=$(
 *   git diff --name-only <baseRef>..HEAD \
 *     | awk -F/ '/^src\// {print $2}' \
 *     | sort -u \
 *     | wc -l
 * )
 * crossPackage=$([ "$topLevelDirs" -gt 1 ] && echo true || echo false)
 *
 * # crossBrain: true when the current checkpoint records more than one repo touched
 * # Inspect brain snapshot — set by the drone's completion comment when >1 repo modified.
 * crossBrain=false  # default; override from checkpoint data when available
 * ```
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inputs to the triviality classifier.
 *
 * All values are pre-extracted by the caller; this function performs no I/O.
 */
export interface TrivialityInput {
  /**
   * Total lines changed (insertions + deletions) across all modified files,
   * derived from `git diff --shortstat <baseRef>..HEAD`.
   */
  locDelta: number;

  /**
   * Number of files modified in this change set, derived from the same
   * `git diff --shortstat` output or `git diff --name-only | wc -l`.
   */
  fileCount: number;

  /**
   * Count of risk-keyword signal matches recorded in
   * `/tmp/unimatrix-routing-<sessionId>.json` under the key `risk_keywords`.
   * Matches the routing classifier signal of the same name (keywords:
   * `auth`, `secret`, `prod`, `critical`, `delete`).
   */
  riskKeywords: number;

  /**
   * True when the modified files span more than one top-level subtree under
   * `src/` (e.g. changes in both `src/skills/` and `src/server/`).
   * Heuristic computed by the caller from `git diff --name-only`.
   */
  crossPackage: boolean;

  /**
   * True when the drone's execution checkpoint records more than one
   * repository touched during this node's work. Set by examining the brain
   * snapshot's repo-touched list.
   */
  crossBrain: boolean;
}

/**
 * Classification verdict returned by {@link classifyTriviality}.
 *
 * - `TRIVIAL` — route to the lightweight subagent-sentinel review tier.
 * - `NON_TRIVIAL` — route to the heavier agent-team review formation.
 */
export type TrivialityVerdict = "TRIVIAL" | "NON_TRIVIAL";

/**
 * Classify whether a change set is trivial enough for the subagent-sentinel
 * review tier.
 *
 * A change set is `TRIVIAL` if and only if **all** of the following hold:
 *
 * 1. `locDelta <= 30` — fewer than or equal to 30 lines changed in total.
 * 2. `fileCount === 1` — exactly one file modified.
 * 3. `riskKeywords === 0` — no routing risk-keyword signals fired.
 * 4. `!crossPackage` — changes confined to a single top-level src/ subtree.
 * 5. `!crossBrain` — only one repository touched during this node's work.
 *
 * If any criterion fails, the verdict is `NON_TRIVIAL`.
 *
 * @param input - Pre-extracted change-set metrics. The caller is responsible
 *   for deriving these from git output and routing signal files.
 * @returns `"TRIVIAL"` or `"NON_TRIVIAL"`.
 */
export function classifyTriviality(input: TrivialityInput): TrivialityVerdict {
  const trivial =
    input.locDelta <= 30 &&
    input.fileCount === 1 &&
    input.riskKeywords === 0 &&
    !input.crossPackage &&
    !input.crossBrain;

  return trivial ? "TRIVIAL" : "NON_TRIVIAL";
}
