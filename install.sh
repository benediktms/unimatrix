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

compile_binaries() {
  local bin_dir="$UNIMATRIX_DIR/bin"
  local server_src="$UNIMATRIX_DIR/src/skills/trimatrix/server.ts"

  [ -f "$server_src" ] || return 0

  if [ ! -f "$bin_dir/unimatrix" ] || [ "$server_src" -nt "$bin_dir/unimatrix" ]; then
    echo "Compiling unimatrix..."
    mkdir -p "$bin_dir"
    (cd "$UNIMATRIX_DIR" && deno compile --allow-read --allow-env --allow-run --output bin/unimatrix src/skills/trimatrix/server.ts)
    echo ""
  fi
}

link_binaries() {
  local bin_dir="$UNIMATRIX_DIR/bin"
  mkdir -p "$HOME/bin"

  if [ -f "$bin_dir/unimatrix" ]; then
    link "$bin_dir/unimatrix" "$HOME/bin/unimatrix"
  fi
}

merge_settings() {
  local target="$1"
  local is_global="${2:-false}"
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

is_global = sys.argv[1] == 'true'
unimatrix_dir = sys.argv[2]
settings_file = sys.argv[3]

existing = json.load(open(settings_file))
incoming = json.loads(sys.stdin.read())

if not is_global:
    # Hooks belong only in global scope — strip from incoming template
    incoming.pop('hooks', None)

    # Cleanup pass: remove pre-existing unimatrix-managed hook entries
    # from project settings. Preserve user-added custom hooks.
    existing_hooks = existing.get('hooks', {})
    cleaned_events = {}
    removed_count = 0
    for event, matcher_groups in existing_hooks.items():
        cleaned_groups = []
        for group in matcher_groups:
            cleaned_hook_list = []
            for hook in group.get('hooks', []):
                cmd = hook.get('command', '')
                if unimatrix_dir in cmd or '__UNIMATRIX_DIR__' in cmd:
                    removed_count += 1
                else:
                    cleaned_hook_list.append(hook)
            if cleaned_hook_list:
                cleaned_groups.append(dict(group, hooks=cleaned_hook_list))
        if cleaned_groups:
            cleaned_events[event] = cleaned_groups
    if removed_count:
        print(f'  clean: removed {removed_count} unimatrix-managed hook(s) from ' + settings_file, file=sys.stderr)
    if cleaned_events:
        existing['hooks'] = cleaned_events
    elif 'hooks' in existing:
        del existing['hooks']
    if not is_global:
        print('  skip: hooks (project scope; install --global to enable)', file=sys.stderr)

existing.update(incoming)
json.dump(existing, sys.stdout, indent=2)
print()
" "$is_global" "$UNIMATRIX_DIR" "$settings_file" <<< "$resolved")
    echo "$merged" > "$settings_file"
  else
    echo "  create: $settings_file"
    if [ "$is_global" = "false" ]; then
      echo "  skip: hooks (project scope; install --global to enable)"
      echo "$resolved" | "$PYTHON" -c "
import json, sys
d = json.load(sys.stdin)
d.pop('hooks', None)
json.dump(d, sys.stdout, indent=2)
print()
" > "$settings_file"
    else
      echo "$resolved" | "$PYTHON" -c "
import json, sys
d = json.load(sys.stdin)
json.dump(d, sys.stdout, indent=2)
print()
" > "$settings_file"
    fi
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
  local is_global="${2:-false}"
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
  # Hooks are written only for global installs; project installs skip and clean them.
  merge_settings "$target" "$is_global"

  # Register unimatrix MCP server (idempotent — skips if already registered)
  if command -v claude > /dev/null 2>&1 && [ -f "$UNIMATRIX_DIR/bin/unimatrix" ]; then
    if claude mcp add unimatrix -- "$UNIMATRIX_DIR/bin/unimatrix" 2>/dev/null; then
      echo "  mcp: registered unimatrix MCP server"
    else
      echo "  mcp: unimatrix MCP server already registered"
    fi
  fi

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
  # Skip project-level .claude/skills/ when the project IS the unimatrix repo and
  # Claude Code skills are already installed globally — otherwise Claude Code sees
  # both global and project skills, causing every skill to appear twice.
  local skip_skills=false
  if [ "$is_global" = "false" ]; then
    local resolved_project resolved_unimatrix
    resolved_project="$(cd "$project_root" 2>/dev/null && pwd)"
    resolved_unimatrix="$(cd "$UNIMATRIX_DIR" 2>/dev/null && pwd)"
    if [ "$resolved_project" = "$resolved_unimatrix" ] && [ -d "$HOME/.claude/skills" ]; then
      # Check if at least one global skill symlink points into our dist
      for glink in "$HOME/.claude/skills/"*; do
        if [ -L "$glink" ]; then
          case "$(readlink "$glink")" in
            "$UNIMATRIX_DIR/dist/claude-code/"*)
              skip_skills=true
              break
              ;;
          esac
        fi
      done
    fi
  fi

  if [ "$skip_skills" = "true" ]; then
    echo "  skip: .claude/skills/ (Claude Code skills already installed globally)"
  else
    mkdir -p "$skills_target"
    for skill_dir in "$dist_claude_skills/"*/; do
      [ -d "$skill_dir" ] || continue
      skill_name="$(basename "$skill_dir")"
      link "$skill_dir" "$skills_target/$skill_name"
    done
    cleanup_stale_links "$skills_target" "$dist_claude_skills/"
  fi

  # Plugins: symlink OpenCode hook plugins (if present)
  if [ -d "$UNIMATRIX_DIR/src/hooks/opencode" ] && [ "$(ls -A "$UNIMATRIX_DIR/src/hooks/opencode" 2>/dev/null)" ]; then
    mkdir -p "$target/plugins"
    for plugin in "$UNIMATRIX_DIR/src/hooks/opencode/"*; do
      [ -f "$plugin" ] || continue
      link "$plugin" "$target/plugins/$(basename "$plugin")"
    done
  fi

  # Themes: install to themes/ directory (global only)
  local dist_themes="$UNIMATRIX_DIR/dist/opencode/themes"
  if [ "$is_global" = "true" ] && [ -d "$dist_themes" ]; then
    mkdir -p "$target/themes"
    for theme_file in "$dist_themes/"*.json; do
      [ -f "$theme_file" ] || continue
      link "$theme_file" "$target/themes/$(basename "$theme_file")"
    done
    cleanup_stale_links "$target/themes" "$dist_themes/"
  fi

  # TUI config: install tui.json (global only, with backup)
  local dist_tui="$UNIMATRIX_DIR/dist/opencode/tui.json"
  if [ "$is_global" = "true" ] && [ -f "$dist_tui" ]; then
    link "$dist_tui" "$target/tui.json"
  fi

  # Register unimatrix MCP server in global OpenCode config (idempotent)
  # MCP servers are system-wide — always register in ~/.config/opencode/opencode.json
  if [ -f "$UNIMATRIX_DIR/bin/unimatrix" ]; then
    local config_file="$HOME/.config/opencode/opencode.json"
    local unimatrix_bin="$UNIMATRIX_DIR/bin/unimatrix"
    mkdir -p "$(dirname "$config_file")"

    if [ -f "$config_file" ]; then
      echo "  mcp: registering unimatrix in $config_file"
      "$PYTHON" -c "
import json, sys
config = json.load(open(sys.argv[1]))
config.setdefault('mcp', {})
config['mcp']['unimatrix'] = {
    'type': 'local',
    'command': [sys.argv[2]],
    'enabled': True
}
json.dump(config, sys.stdout, indent='\t')
print()
" "$config_file" "$unimatrix_bin" > "${config_file}.tmp" && mv "${config_file}.tmp" "$config_file"
    else
      echo "  mcp: creating $config_file with unimatrix MCP"
      "$PYTHON" -c "
import json, sys
config = {
    '\$schema': 'https://opencode.ai/config.json',
    'mcp': {
        'unimatrix': {
            'type': 'local',
            'command': [sys.argv[1]],
            'enabled': True
        }
    }
}
json.dump(config, sys.stdout, indent='\t')
print()
" "$unimatrix_bin" > "$config_file"
    fi
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

# Compile and link binaries (platform-agnostic, runs once)
compile_binaries
link_binaries

case "$PLATFORM" in
  claude)
    if [ "$TARGET_MODE" = "global" ]; then
      install_claude "$HOME/.claude" "true"
    else
      install_claude "$PROJECT_PATH/.claude" "false"
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
      install_claude "$HOME/.claude" "true"
      echo ""
      install_opencode "$HOME" "true"
    else
      install_claude "$PROJECT_PATH/.claude" "false"
      echo ""
      install_opencode "$PROJECT_PATH"
    fi
    ;;
esac
