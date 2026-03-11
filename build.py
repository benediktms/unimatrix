#!/usr/bin/env python3
"""build.py — Generate platform-specific output from combined unimatrix source files.

Reads combined source files from src/, processes frontmatter and conditional
sections, and writes platform-specific output to dist/.

See FORMAT.md for the complete specification.

Usage:
    python3 build.py --target all        # Build for both platforms (default)
    python3 build.py --target claude      # Build for Claude Code only
    python3 build.py --target opencode    # Build for OpenCode only
    python3 build.py --validate           # Validate source files only
    python3 build.py --clean              # Remove dist/ directory
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
from typing import Any

import yaml

# Map short model aliases to OpenCode model IDs.
# Claude Code understands short aliases natively; OpenCode requires full IDs.
OPENCODE_MODEL_MAP: dict[str, str] = {
    "opus": "anthropic/claude-opus-4-6",
    "sonnet": "anthropic/claude-sonnet-4-6",
    "haiku": "anthropic/claude-haiku-4-5-20251001",
}

# ---------------------------------------------------------------------------
# YAML handling — thin wrappers around PyYAML
# ---------------------------------------------------------------------------


def parse_yaml(text: str) -> dict[str, Any]:
    """Parse YAML frontmatter text into a dict."""
    result = yaml.safe_load(text)
    return result if isinstance(result, dict) else {}


def dump_yaml(data: dict[str, Any]) -> str:
    """Dump a dict as YAML for frontmatter.

    Uses block style, preserves key order, no document-end marker.
    """
    return yaml.dump(
        data,
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
        width=200,  # Avoid line-wrapping long descriptions
    )


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SRC = Path("src")
DIST = Path("dist")

PLATFORMS = ("claude", "opencode")

# Platform-specific output directories for each source category.
OUTPUT_MAP: dict[str, dict[str, Path]] = {
    "agents": {
        "claude": DIST / "claude-code" / ".claude" / "agents",
        "opencode": DIST / "opencode" / ".opencode" / "agents",
    },
    "skills": {
        "claude": DIST / "claude-code" / ".claude" / "skills",
        "opencode": DIST
        / "opencode"
        / ".claude"
        / "skills",  # OpenCode reads .claude/skills/
    },
    "rules": {
        "claude": DIST / "claude-code" / ".claude" / "rules",
        "opencode": DIST / "opencode" / ".opencode" / "rules",
    },
    "lead": {
        "claude": DIST / "claude-code",
        "opencode": DIST / "opencode",
    },
}

# Regex: YAML frontmatter block
FM_RE = re.compile(r"\A---[ \t]*\n(.*?\n)---[ \t]*\n", re.DOTALL)

# Regex: conditional section markers  <!-- @platform --> ... <!-- @end -->
COND_RE = re.compile(
    r"^<!-- @(\w+) -->[ \t]*\n(.*?)^<!-- @end -->[ \t]*\n",
    re.DOTALL | re.MULTILINE,
)


# ---------------------------------------------------------------------------
# Frontmatter processing
# ---------------------------------------------------------------------------


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Split a file into (frontmatter_dict, body_text).

    Returns ({}, content) if no valid frontmatter is found.
    """
    match = FM_RE.match(content)
    if not match:
        return {}, content
    fm = parse_yaml(match.group(1))
    body = content[match.end() :]
    return fm, body


def merge_frontmatter(fm: dict[str, Any], target: str) -> dict[str, Any]:
    """Merge shared fields with the target platform's override section.

    Rules (per FORMAT.md):
    - Top-level keys not in PLATFORMS and not 'platforms' are shared.
    - The target platform's section is deep-merged on top of shared fields.
    - Platform section values override shared values on conflict.
    """
    shared: dict[str, Any] = {}
    for key, value in fm.items():
        if key in PLATFORMS or key == "platforms":
            continue
        shared[key] = value

    platform_overrides = fm.get(target, {})
    if isinstance(platform_overrides, dict):
        shared.update(platform_overrides)

    return shared


def render_frontmatter(fm: dict[str, Any], target: str, category: str) -> str:
    """Render a merged frontmatter dict as a YAML frontmatter block.

    Applies platform-specific post-processing:
    - OpenCode agents: remove 'name' field (derived from filename).
    - OpenCode agents: map model short aliases to anthropic/model-id format.
    """
    output = dict(fm)

    if target == "opencode" and category == "agents":
        output.pop("name", None)
        # Map short model aliases to OpenCode's anthropic/model-id format
        model = output.get("model")
        if model and "/" not in model:
            output["model"] = OPENCODE_MODEL_MAP.get(model, f"anthropic/{model}")

    if not output:
        return ""

    return "---\n" + dump_yaml(output) + "---\n\n"


# ---------------------------------------------------------------------------
# Conditional section processing
# ---------------------------------------------------------------------------


def strip_conditionals(body: str, target: str) -> str:
    """Process conditional markers: keep target sections, remove others.

    - <!-- @target --> ... <!-- @end -->  →  keep content, strip markers
    - <!-- @other -->  ... <!-- @end -->  →  remove entirely
    """

    def replacer(match: re.Match) -> str:
        platform = match.group(1)
        content = match.group(2)
        if platform == target:
            return content  # Keep content, drop markers
        return ""  # Remove non-target section entirely

    return COND_RE.sub(replacer, body)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class ValidationError:
    """A single validation issue."""

    def __init__(self, path: Path, line: int, message: str) -> None:
        self.path = path
        self.line = line
        self.message = message

    def __str__(self) -> str:
        return f"  {self.path}:{self.line}: {self.message}"


def validate_file(path: Path) -> list[ValidationError]:
    """Validate a single source file for format issues."""
    errors: list[ValidationError] = []
    content = path.read_text(encoding="utf-8")

    # Check frontmatter parses
    try:
        fm, body = parse_frontmatter(content)
    except Exception as exc:
        errors.append(ValidationError(path, 1, f"invalid YAML frontmatter: {exc}"))
        return errors

    # Check 'platforms' field if present
    platforms = fm.get("platforms")
    if platforms is not None:
        if not isinstance(platforms, list):
            errors.append(ValidationError(path, 1, "'platforms' must be a list"))
        else:
            for p in platforms:
                if p not in PLATFORMS:
                    errors.append(ValidationError(path, 1, f"unknown platform: '{p}'"))

    # Check required 'description' for agents (OpenCode requires it)
    if "agents" in str(path.parts):
        if "description" not in fm and "description" not in fm.get("opencode", {}):
            errors.append(
                ValidationError(path, 1, "missing 'description' (required by OpenCode)")
            )

    # Validate conditional markers in body
    lines = body.splitlines(keepends=True)
    # Estimate the starting line number (after frontmatter)
    fm_match = FM_RE.match(content)
    body_start = content[: fm_match.end()].count("\n") + 1 if fm_match else 1

    open_stack: list[tuple[int, str]] = []

    for i, line in enumerate(lines, start=body_start):
        stripped = line.strip()

        # Check for opening marker
        open_match = re.match(r"^<!-- @(\w+) -->$", stripped)
        if open_match:
            platform = open_match.group(1)
            if platform == "end":
                if not open_stack:
                    errors.append(
                        ValidationError(
                            path, i, "<!-- @end --> without matching opener"
                        )
                    )
                else:
                    open_stack.pop()
                continue

            if platform not in PLATFORMS:
                errors.append(
                    ValidationError(
                        path, i, f"unknown platform in marker: '@{platform}'"
                    )
                )

            if open_stack:
                errors.append(
                    ValidationError(
                        path,
                        i,
                        f"nested conditional: @{platform} inside @{open_stack[-1][1]}",
                    )
                )

            open_stack.append((i, platform))
            continue

        # Check for closing marker
        if stripped == "<!-- @end -->":
            if not open_stack:
                errors.append(
                    ValidationError(path, i, "<!-- @end --> without matching opener")
                )
            else:
                open_stack.pop()

    # Check for unclosed markers
    for line_num, platform in open_stack:
        errors.append(
            ValidationError(path, line_num, f"unclosed <!-- @{platform} --> marker")
        )

    return errors


def validate_all() -> list[ValidationError]:
    """Validate all source files under src/."""
    errors: list[ValidationError] = []
    for md in sorted(SRC.rglob("*.md")):
        errors.extend(validate_file(md))
    return errors


# ---------------------------------------------------------------------------
# Build pipeline
# ---------------------------------------------------------------------------


def should_build(fm: dict[str, Any], target: str) -> bool:
    """Check if a file should be built for the given target platform."""
    platforms = fm.get("platforms")
    if platforms is None:
        return True  # No restriction — build for all
    return target in platforms


def detect_category(path: Path) -> str | None:
    """Detect the source category from file path (agents, skills, rules, lead)."""
    parts = path.parts
    if parts[0] in OUTPUT_MAP:
        return parts[0]
    return None


def build_file(src_path: Path, target: str) -> None:
    """Process a single source file and write to dist/."""
    content = src_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)

    # Check platform filter
    if not should_build(fm, target):
        return

    # Detect category for output path mapping
    rel = src_path.relative_to(SRC)
    category = detect_category(rel)
    if category is None:
        return  # Unknown category, skip

    # Merge frontmatter
    merged_fm = merge_frontmatter(fm, target)

    # Strip conditional sections
    processed_body = strip_conditionals(body, target)

    # Render output
    rendered_fm = render_frontmatter(merged_fm, target, category)
    output_content = rendered_fm + processed_body

    # Determine output path
    base_dir = OUTPUT_MAP[category][target]
    # For skills: preserve subdirectory structure (e.g. skills/assemble/SKILL.md)
    # For agents/rules: flat file (e.g. agents/drone.md)
    rel_within_category = Path(*rel.parts[1:])  # Strip category prefix
    out_path = base_dir / rel_within_category

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(output_content, encoding="utf-8")


def copy_hooks(target: str) -> None:
    """Copy platform-specific hooks to dist/."""
    hooks_src = SRC / "hooks" / target
    if not hooks_src.exists():
        return

    if target == "claude":
        hooks_dst = DIST / "claude-code" / "hooks"
    else:
        hooks_dst = DIST / "opencode" / ".opencode" / "plugins"

    if hooks_dst.exists():
        shutil.rmtree(hooks_dst)
    shutil.copytree(hooks_src, hooks_dst)


def copy_shared(target: str) -> None:
    """Copy shared assets (statusline, etc.) to dist/."""
    shared_src = SRC / "shared"
    if not shared_src.exists() or not any(shared_src.iterdir()):
        return

    if target == "claude":
        shared_dst = DIST / "claude-code" / "shared"
    else:
        shared_dst = DIST / "opencode" / "shared"

    shared_dst.mkdir(parents=True, exist_ok=True)
    for item in shared_src.iterdir():
        dest = shared_dst / item.name
        if item.is_file():
            shutil.copy2(item, dest)


def copy_settings(target: str) -> None:
    """Copy platform-specific settings/config files."""
    if target == "claude":
        src = Path("settings.json")
        if src.exists():
            dst = DIST / "claude-code" / ".claude" / "settings.json"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


def build(target: str) -> int:
    """Run the full build pipeline for a target platform."""
    print(f"Building for {target}...")
    count = 0

    # Process all markdown files in src/
    for md in sorted(SRC.rglob("*.md")):
        # Skip hook files — they're copied as-is
        if "hooks" in md.parts:
            continue
        build_file(md, target)
        count += 1

    # Copy hooks
    copy_hooks(target)

    # Copy shared assets
    copy_shared(target)

    # Copy settings
    copy_settings(target)

    target_dir = "claude-code" if target == "claude" else "opencode"
    print(f"  → {count} files processed → {DIST / target_dir}")
    return count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build platform-specific unimatrix output from combined source files.",
        epilog="See FORMAT.md for the complete source format specification.",
    )
    parser.add_argument(
        "--target",
        choices=["claude", "opencode", "all"],
        default="all",
        help="Target platform (default: all)",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate source files without building",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove dist/ directory",
    )

    args = parser.parse_args()

    # Clean
    if args.clean:
        if DIST.exists():
            shutil.rmtree(DIST)
            print("Cleaned dist/")
        else:
            print("dist/ does not exist")
        return

    # Validate
    if args.validate:
        errors = validate_all()
        if errors:
            print(f"Found {len(errors)} issue(s):", file=sys.stderr)
            for err in errors:
                print(err, file=sys.stderr)
            sys.exit(1)
        else:
            print("All source files valid.")
        return

    # Build
    targets = list(PLATFORMS) if args.target == "all" else [args.target]

    # Always validate first
    errors = validate_all()
    if errors:
        print(f"Validation failed with {len(errors)} issue(s):", file=sys.stderr)
        for err in errors:
            print(err, file=sys.stderr)
        sys.exit(1)

    # Clean target dirs
    for t in targets:
        target_dir = DIST / ("claude-code" if t == "claude" else "opencode")
        if target_dir.exists():
            shutil.rmtree(target_dir)

    total = 0
    for t in targets:
        total += build(t)

    print(f"\nDone. {total} files processed for {len(targets)} platform(s).")


if __name__ == "__main__":
    main()
