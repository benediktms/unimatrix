#!/bin/bash
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name')
AGENT=$(echo "$input" | jq -r '.agent.name // empty')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

DIM='\033[2m'
BOLD='\033[1m'
GREEN='\033[32m'
CYAN='\033[36m'
YELLOW='\033[33m'
RED='\033[31m'
MAGENTA='\033[35m'
RESET='\033[0m'

# Context color based on usage
if [ "$PCT" -ge 80 ]; then
  CTX_COLOR="$RED"
elif [ "$PCT" -ge 50 ]; then
  CTX_COLOR="$YELLOW"
else
  CTX_COLOR="$GREEN"
fi

# Agent designation
case "$AGENT" in
  queen)
    echo -e "${MAGENTA}${BOLD}[QUEEN]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
  drone)
    echo -e "${GREEN}${BOLD}[DRONE]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
  vinculum)
    echo -e "${CYAN}${BOLD}[VINCULUM]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
  probe)
    echo -e "${YELLOW}${BOLD}[PROBE]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
  subroutine)
    echo -e "${DIM}[SUBROUTINE]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
  "")
    echo -e "${DIM}[UNIMATRIX]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
  *)
    echo -e "${DIM}[${AGENT}]${RESET} ${DIM}${MODEL}${RESET} ${CTX_COLOR}${PCT}%${RESET}" ;;
esac
