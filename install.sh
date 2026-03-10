#!/usr/bin/env bash
set -euo pipefail

UNIMATRIX_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: install.sh [--global | --project <path>]"
  echo ""
  echo "  --global          Install to ~/.claude/ (available in all projects)"
  echo "  --project <path>  Install to <path>/.claude/ (project-specific)"
  echo ""
  echo "Examples:"
  echo "  ./install.sh --global"
  echo "  ./install.sh --project ~/code/my-project"
  exit 1
}

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

install_to() {
  local target="$1"
  mkdir -p "$target"

  echo "Installing unimatrix to $target"
  echo ""

  # Agents and rules: symlink the whole directory
  link "$UNIMATRIX_DIR/agents" "$target/agents"
  link "$UNIMATRIX_DIR/rules"  "$target/rules"

  # Skills: symlink individual skills to preserve existing ones
  mkdir -p "$target/skills"
  for skill_dir in "$UNIMATRIX_DIR"/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    link "$skill_dir" "$target/skills/$skill_name"
  done

  echo ""
  echo "Done. Restart Claude Code to pick up changes."
}

if [ $# -eq 0 ]; then
  usage
fi

case "$1" in
  --global)
    install_to "$HOME/.claude"
    ;;
  --project)
    [ -z "${2:-}" ] && usage
    install_to "$2/.claude"
    ;;
  *)
    usage
    ;;
esac
