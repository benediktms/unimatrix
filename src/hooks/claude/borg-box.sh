#!/usr/bin/env bash
# Shared bordered message renderer for unimatrix hooks

borg_box() {
  local stream="${1:-1}"
  shift
  local lines=("$@")

  # Find longest line
  local max=0
  for line in "${lines[@]}"; do
    (( ${#line} > max )) && max=${#line}
  done

  local w=$((max + 2))
  local bar
  bar=$(printf '═%.0s' $(seq 1 "$w"))

  {
    echo "╔${bar}╗"
    for line in "${lines[@]}"; do
      printf "║ %-${max}s ║\n" "$line"
    done
    echo "╚${bar}╝"
  } >&"$stream"
}
