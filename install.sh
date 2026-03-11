#!/usr/bin/env bash
set -euo pipefail

UNIMATRIX_DIR="$(cd "$(dirname "$0")" && pwd)"

# Prefer venv python (has PyYAML); fall back to system python
PYTHON="$UNIMATRIX_DIR/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON="python3"

usage() {
  echo "Usage: install.sh <platform> [--global | --project <path>]"
  echo ""
  echo "Platforms:"
  echo "  --claude          Install Claude Code config"
  echo "  --opencode        Install OpenCode config"
  echo "  --both            Install for both platforms"
  echo ""
  echo "Targets:"
  echo "  --global          Install globally (~/.claude/ or ~/.config/opencode/)"
  echo "  --project <path>  Install to a specific project directory"
  echo ""
  echo "Examples:"
  echo "  ./install.sh --claude --global"
  echo "  ./install.sh --opencode --project ~/code/my-project"
  echo "  ./install.sh --both --global"
  exit 1
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

link() {
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    echo "  update: $dst -> $src"
    rm "$dst"
  elif [ -e "$dst" ]; then
    echo "  backup: $dst -> ${dst}.bak"
    mv "$dst" "${dst}.bak"
  else
    echo "  create: $dst -> $src"
  fi
  ln -sfn "$src" "$dst"
}

ensure_build() {
  local target="$1"
  local dist_dir="$UNIMATRIX_DIR/dist/$target"

  if [ ! -d "$dist_dir" ] || [ "$UNIMATRIX_DIR/build.py" -nt "$dist_dir" ]; then
    echo "Building $target output..."
    "$PYTHON" "$UNIMATRIX_DIR/build.py" --target "$target"
    echo ""
  fi
}

merge_settings() {
  local target="$1"
  local settings_file="$target/settings.json"
  local unimatrix_settings="$UNIMATRIX_DIR/settings.json"

  [ -f "$unimatrix_settings" ] || return 0

  # Replace placeholder with actual path
  local resolved
  resolved=$(sed "s|__UNIMATRIX_DIR__|$UNIMATRIX_DIR|g" "$unimatrix_settings")

  if [ -f "$settings_file" ]; then
    echo "  merge: unimatrix settings into $settings_file"
    local merged
    merged=$("$PYTHON" -c "
import json, sys
existing = json.load(open('$settings_file'))
incoming = json.loads('''$resolved''')
existing.update(incoming)
json.dump(existing, sys.stdout, indent=2)
print()
")
    echo "$merged" > "$settings_file"
  else
    echo "  create: $settings_file"
    echo "$resolved" | "$PYTHON" -c "
import json, sys
d = json.load(sys.stdin)
json.dump(d, sys.stdout, indent=2)
print()
" > "$settings_file"
  fi
}

# ---------------------------------------------------------------------------
# Clean up stale unimatrix symlinks in a directory
# ---------------------------------------------------------------------------

cleanup_stale_links() {
  local dir="$1" source_prefix="$2"
  [ -d "$dir" ] || return 0
  for existing_link in "$dir"/*; do
    [ -L "$existing_link" ] || continue
    link_target="$(readlink "$existing_link")"
    case "$link_target" in
      "$source_prefix"*)
        if [ ! -e "$existing_link" ]; then
          echo "  remove stale: $existing_link -> $link_target"
          rm "$existing_link"
        fi
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Platform installers
# ---------------------------------------------------------------------------

install_claude() {
  local target="$1"
  local dist="$UNIMATRIX_DIR/dist/claude-code/.claude"

  ensure_build "claude"
  mkdir -p "$target"

  echo "Installing unimatrix (Claude Code) to $target"
  echo ""

  # Agents and rules: symlink the built directories
  link "$dist/agents" "$target/agents"
  link "$dist/rules"  "$target/rules"

  # Skills: symlink individual skills to preserve existing ones
  mkdir -p "$target/skills"
  for skill_dir in "$dist/skills/"*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    link "$skill_dir" "$target/skills/$skill_name"
  done
  cleanup_stale_links "$target/skills" "$dist/skills/"

  # Merge settings (spinner verbs, status line, hooks)
  merge_settings "$target"

  # Git hooks
  if git -C "$UNIMATRIX_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "  hooks: core.hooksPath -> $UNIMATRIX_DIR/src/hooks/claude"
    git -C "$UNIMATRIX_DIR" config --local core.hooksPath "$UNIMATRIX_DIR/src/hooks/claude"
  fi

  echo ""
  echo "Done (Claude Code). Restart Claude Code to pick up changes."
}

install_opencode() {
  local project_root="$1"
  local is_global="${2:-false}"
  local dist_oc="$UNIMATRIX_DIR/dist/opencode/.opencode"
  local dist_claude_skills="$UNIMATRIX_DIR/dist/opencode/.claude/skills"

  # Global installs go to ~/.config/opencode/ (OpenCode's global config home).
  # Project installs go to <project>/.opencode/ (OpenCode's project discovery path).
  local target
  local skills_target
  if [ "$is_global" = "true" ]; then
    target="$HOME/.config/opencode"
    skills_target="$HOME/.config/opencode/skills"
  else
    target="$project_root/.opencode"
    skills_target="$project_root/.claude/skills"
  fi

  ensure_build "opencode"
  mkdir -p "$target"

  echo "Installing unimatrix (OpenCode) to $target"
  echo ""

  # Agents: symlink built .opencode/agents/
  link "$dist_oc/agents" "$target/agents"

  # Rules: symlink built .opencode/rules/ (if present)
  if [ -d "$dist_oc/rules" ]; then
    link "$dist_oc/rules" "$target/rules"
  fi

  # Skills: global uses ~/.config/opencode/skills/, project uses .claude/skills/
  mkdir -p "$skills_target"
  for skill_dir in "$dist_claude_skills/"*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    link "$skill_dir" "$skills_target/$skill_name"
  done
  cleanup_stale_links "$skills_target" "$dist_claude_skills/"

  # Plugins: symlink OpenCode hook plugins (if present)
  if [ -d "$UNIMATRIX_DIR/src/hooks/opencode" ] && [ "$(ls -A "$UNIMATRIX_DIR/src/hooks/opencode" 2>/dev/null)" ]; then
    mkdir -p "$target/plugins"
    for plugin in "$UNIMATRIX_DIR/src/hooks/opencode/"*; do
      [ -f "$plugin" ] || continue
      link "$plugin" "$target/plugins/$(basename "$plugin")"
    done
  fi

  # Clean up stale global symlinks from old install path (~/.opencode/)
  if [ "$is_global" = "true" ] && [ -d "$HOME/.opencode" ]; then
    cleanup_stale_links "$HOME/.opencode/agents" "$dist_oc/"
    cleanup_stale_links "$HOME/.opencode/rules" "$dist_oc/"
    cleanup_stale_links "$HOME/.opencode/plugins" "$UNIMATRIX_DIR/src/hooks/opencode/"
    # Remove stale top-level symlinks
    for stale in "$HOME/.opencode/agents" "$HOME/.opencode/rules"; do
      if [ -L "$stale" ]; then
        echo "  remove stale: $stale"
        rm "$stale"
      fi
    done
  fi

  echo ""
  echo "Done (OpenCode). Restart OpenCode to pick up changes."
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

PLATFORM=""
TARGET_MODE=""
PROJECT_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --claude)   PLATFORM="claude"; shift ;;
    --opencode) PLATFORM="opencode"; shift ;;
    --both)     PLATFORM="both"; shift ;;
    --global)   TARGET_MODE="global"; shift ;;
    --project)
      TARGET_MODE="project"
      [ -z "${2:-}" ] && usage
      PROJECT_PATH="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[ -z "$PLATFORM" ] && usage
[ -z "$TARGET_MODE" ] && usage

case "$PLATFORM" in
  claude)
    if [ "$TARGET_MODE" = "global" ]; then
      install_claude "$HOME/.claude"
    else
      install_claude "$PROJECT_PATH/.claude"
    fi
    ;;
  opencode)
    if [ "$TARGET_MODE" = "global" ]; then
      install_opencode "$HOME" "true"
    else
      install_opencode "$PROJECT_PATH"
    fi
    ;;
  both)
    if [ "$TARGET_MODE" = "global" ]; then
      install_claude "$HOME/.claude"
      echo ""
      install_opencode "$HOME" "true"
    else
      install_claude "$PROJECT_PATH/.claude"
      echo ""
      install_opencode "$PROJECT_PATH"
    fi
    ;;
esac
