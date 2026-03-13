#!/usr/bin/env python3
"""ensure-brain.py — Resolve and optionally initialize brain targets.

Usage: ensure-brain.py <ref>[,<ref>,...] [<ref>[,<ref>,...] ...]

Each <ref> can be a brain ID, brain name, brain alias, or filesystem path.
Arguments may be comma-separated (e.g. "brain1,brain2,~/code/foo")
or space-separated — both are supported interchangeably.

Resolution order per ref (first match wins):
  1. Brain ID    — exact match against registered brain IDs
  2. Brain name  — exact match against registered brain names
  3. Brain alias — exact match against registered brain aliases
  4. Path        — match against registered brain roots, or auto-init if unregistered

Output: one JSON line per resolved ref:
  {"id": "...", "name": "...", "root": "/abs/path", "initialized": false}

On error for a specific ref:
  {"error": "...", "ref": "..."}

Exit code 0 if all resolved, 1 if any errors.
"""

import json
import subprocess
import sys
from pathlib import Path


def load_registry() -> list[dict]:
    """Load the brain registry via brain ls --json."""
    result = subprocess.run(
        ["brain", "ls", "--json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(
            f"Error: brain ls --json failed: {result.stderr.strip()}",
            file=sys.stderr,
        )
        sys.exit(1)
    data = json.loads(result.stdout)
    return data.get("brains", [])


def build_lookups(brains: list[dict]) -> tuple[dict, dict, dict, dict]:
    """Build id→entry, name→entry, alias→entry, and root→entry lookup dicts."""
    by_id = {}
    by_name = {}
    by_alias = {}
    by_root = {}
    for b in brains:
        if b.get("id"):
            by_id[b["id"]] = b
        by_name[b["name"]] = b
        for alias in b.get("aliases", []):
            by_alias[alias] = b
        root = str(Path(b["root"]).resolve())
        by_root[root] = b
    return by_id, by_name, by_alias, by_root


def make_result(entry: dict, initialized: bool = False) -> dict:
    """Build a result dict from a registry entry."""
    return {
        "id": entry.get("id"),
        "name": entry["name"],
        "root": entry["root"],
        "initialized": initialized,
    }


def resolve(ref: str, by_id: dict, by_name: dict, by_alias: dict, by_root: dict) -> dict:
    """Resolve a single ref to a brain entry. Order: ID → name → alias → path."""
    # 1. Try as brain ID
    if ref in by_id:
        return make_result(by_id[ref])

    # 2. Try as brain name
    if ref in by_name:
        return make_result(by_name[ref])

    # 3. Try as brain alias
    if ref in by_alias:
        return make_result(by_alias[ref])

    # 4. Try as path
    path = Path(ref).expanduser().resolve()
    path_str = str(path)

    if path_str in by_root:
        return make_result(by_root[path_str])

    # Not registered — try to initialize
    if not path.is_dir():
        return {
            "error": f"'{ref}' is not a registered brain (by ID, name, or alias) and not a valid directory",
            "ref": ref,
        }

    result = subprocess.run(
        ["brain", "init", "--no-agents-md"],
        cwd=path_str,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {
            "error": f"brain init failed at {path_str}: {result.stderr.strip()}",
            "ref": ref,
        }

    # Re-query registry to get the registered entry
    brains = load_registry()
    _, _, new_by_root = build_lookups(brains)

    if path_str in new_by_root:
        return make_result(new_by_root[path_str], initialized=True)

    # Fallback — use directory name
    return {"id": None, "name": path.name, "root": path_str, "initialized": True}


def parse_refs(args: list[str]) -> list[str]:
    """Expand comma-separated arguments into individual refs."""
    refs = []
    for arg in args:
        for part in arg.split(","):
            stripped = part.strip()
            if stripped:
                refs.append(stripped)
    return refs


def main():
    if len(sys.argv) < 2:
        print(
            "Usage: ensure-brain.py <ref>[,<ref>,...] [<ref>[,<ref>,...] ...]",
            file=sys.stderr,
        )
        sys.exit(1)

    refs = parse_refs(sys.argv[1:])
    brains = load_registry()
    by_id, by_name, by_alias, by_root = build_lookups(brains)

    errors = False
    for ref in refs:
        entry = resolve(ref, by_id, by_name, by_alias, by_root)
        print(json.dumps(entry))
        if "error" in entry:
            errors = True

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
