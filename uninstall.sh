#!/usr/bin/env bash
set -euo pipefail

UNIMATRIX_DIR="$(cd "$(dirname "$0")" && pwd)"

PYTHON="$UNIMATRIX_DIR/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON="python3"

usage() {
  echo "Usage: uninstall.sh [--global | --project <path>]"
  echo ""
  echo "Targets:"
  echo "  --global          Uninstall globally (~/.claude/, ~/.config/opencode/, ~/bin)"
  echo "  --project <path>  Uninstall from a specific project directory"
  exit 1
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Remove a symlink only if it points into the unimatrix dist or source tree
remove_unimatrix_link() {
  local path="$1"
  [ -L "$path" ] || return 0
  local target
  target="$(readlink "$path")"
  case "$target" in
    "$UNIMATRIX_DIR"*)
      echo "  remove: $path -> $target"
      rm "$path"
      ;;
  esac
}

# Remove all unimatrix symlinks inside a directory
remove_unimatrix_links_in() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  for entry in "$dir"/*; do
    remove_unimatrix_link "$entry"
  done
}

# Remove a directory if it's empty after cleanup
rmdir_if_empty() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "  rmdir: $dir (empty)"
    rmdir "$dir"
  fi
}

# ---------------------------------------------------------------------------
# Platform uninstallers
# ---------------------------------------------------------------------------

uninstall_claude() {
  local target="$1"

  echo "Uninstalling unimatrix (Claude Code) from $target"
  echo ""

  # Agents and rules symlinks
  remove_unimatrix_link "$target/agents"
  remove_unimatrix_link "$target/rules"

  # Skill symlinks
  remove_unimatrix_links_in "$target/skills"
  rmdir_if_empty "$target/skills"

  # Remove unimatrix MCP server (try all scopes)
  if command -v claude > /dev/null 2>&1; then
    local removed=false
    for scope in local project user; do
      if claude mcp remove unimatrix -s "$scope" 2>/dev/null; then
        echo "  mcp: removed unimatrix MCP server (scope: $scope)"
        removed=true
      fi
    done
    if [ "$removed" = false ]; then
      echo "  mcp: unimatrix MCP server not registered (skipping)"
    fi
  fi

  # Remove unimatrix keys from settings.json (if present)
  local settings_file="$target/settings.json"
  if [ -f "$settings_file" ] && [ -f "$UNIMATRIX_DIR/settings.json" ]; then
    local unimatrix_keys
    unimatrix_keys=$("$PYTHON" -c "import json, sys; print(' '.join(json.load(open(sys.argv[1])).keys()))" "$UNIMATRIX_DIR/settings.json" 2>/dev/null || true)
    if [ -n "$unimatrix_keys" ]; then
      echo "  settings: removing unimatrix keys from $settings_file"
      "$PYTHON" -c "
import json, sys
settings = json.load(open(sys.argv[1]))
for key in sys.argv[2:]:
    settings.pop(key, None)
json.dump(settings, sys.stdout, indent=2)
print()
" "$settings_file" $unimatrix_keys > "${settings_file}.tmp" && mv "${settings_file}.tmp" "$settings_file"
    fi
  fi

  echo ""
  echo "Done (Claude Code)."
}

uninstall_opencode() {
  local is_global="${1:-false}"

  local target
  local skills_target
  if [ "$is_global" = "true" ]; then
    target="$HOME/.config/opencode"
    skills_target="$HOME/.config/opencode/skills"
  else
    target="${2:?project path required}/.opencode"
    skills_target="${2}/.claude/skills"
  fi

  echo "Uninstalling unimatrix (OpenCode) from $target"
  echo ""

  # Agents and rules
  remove_unimatrix_link "$target/agents"
  remove_unimatrix_link "$target/rules"

  # Skills
  remove_unimatrix_links_in "$skills_target"
  rmdir_if_empty "$skills_target"

  # Plugins
  remove_unimatrix_links_in "$target/plugins"
  rmdir_if_empty "$target/plugins"

  # Themes
  remove_unimatrix_links_in "$target/themes"
  rmdir_if_empty "$target/themes"

  # TUI config
  remove_unimatrix_link "$target/tui.json"

  # Remove unimatrix MCP from opencode.json
  local config_file="$HOME/.config/opencode/opencode.json"
  if [ -f "$config_file" ]; then
    echo "  mcp: removing unimatrix from $config_file"
    "$PYTHON" -c "
import json, sys
config = json.load(open(sys.argv[1]))
if 'mcp' in config:
    config['mcp'].pop('unimatrix', None)
    if not config['mcp']:
        del config['mcp']
json.dump(config, sys.stdout, indent='\t')
print()
" "$config_file" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"
  fi

  echo ""
  echo "Done (OpenCode)."
}

uninstall_binaries() {
  remove_unimatrix_link "$HOME/bin/unimatrix"
  rmdir_if_empty "$HOME/bin"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

TARGET_MODE=""
PROJECT_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --global)  TARGET_MODE="global"; shift ;;
    --project)
      TARGET_MODE="project"
      [ -z "${2:-}" ] && usage
      PROJECT_PATH="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[ -z "$TARGET_MODE" ] && usage

if [ "$TARGET_MODE" = "global" ]; then
  uninstall_binaries
  echo ""
  uninstall_claude "$HOME/.claude"
  echo ""
  uninstall_opencode "true"
else
  uninstall_claude "$PROJECT_PATH/.claude"
  echo ""
  uninstall_opencode "false" "$PROJECT_PATH"
fi
