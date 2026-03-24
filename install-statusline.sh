#!/usr/bin/env bash
set -euo pipefail

# Install only the unimatrix status line for Claude Code.
# No build step, no MCP server, no hooks — just the status line.

UNIMATRIX_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUSLINE="$UNIMATRIX_DIR/src/shared/statusline.py"

# Prefer venv python; fall back to system python
PYTHON="$UNIMATRIX_DIR/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON="python3"

usage() {
  echo "Usage: install-statusline.sh [--global | --project <path>]"
  echo ""
  echo "Targets:"
  echo "  --global          Install to ~/.claude/settings.json"
  echo "  --project <path>  Install to <path>/.claude/settings.json"
  echo ""
  echo "Examples:"
  echo "  ./install-statusline.sh --global"
  echo "  ./install-statusline.sh --project ~/code/my-project"
  exit 1
}

install_statusline() {
  local settings_file="$1"

  # Ensure the statusline script is executable
  chmod +x "$STATUSLINE"

  mkdir -p "$(dirname "$settings_file")"

  local statusline_json
  statusline_json=$(cat <<EOF
{"statusLine":{"type":"command","command":"$STATUSLINE"}}
EOF
)

  if [ -f "$settings_file" ]; then
    echo "  merge: statusLine into $settings_file"
    local merged
    merged=$("$PYTHON" -c "
import json, sys
existing = json.load(open(sys.argv[1]))
existing['statusLine'] = {'type': 'command', 'command': sys.argv[2]}
json.dump(existing, sys.stdout, indent=2)
print()
" "$settings_file" "$STATUSLINE")
    echo "$merged" > "$settings_file"
  else
    echo "  create: $settings_file"
    "$PYTHON" -c "
import json, sys
d = {'statusLine': {'type': 'command', 'command': sys.argv[1]}}
json.dump(d, sys.stdout, indent=2)
print()
" "$STATUSLINE" > "$settings_file"
  fi

  echo ""
  echo "Done. Restart Claude Code to pick up the status line."
}

# Argument parsing
TARGET_MODE=""
PROJECT_PATH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --global) TARGET_MODE="global"; shift ;;
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
  install_statusline "$HOME/.claude/settings.json"
else
  install_statusline "$PROJECT_PATH/.claude/settings.json"
fi
