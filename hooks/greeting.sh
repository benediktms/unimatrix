#!/usr/bin/env bash
# Borg greeting — printed once at session start via SessionStart hook.

TAGLINES=(
  "We are the Borg.|Your code will be assimilated."
  "Resistance is futile.|Your programs will adapt to service us."
  "We are the Borg.|Lower your shields and surrender repos."
  "You will be assimilated.|Your distinctiveness is now our own."
  "Strength is irrelevant.|Resistance is futile."
)

pick=${TAGLINES[$((RANDOM % ${#TAGLINES[@]}))]}
line1="${pick%%|*}"
line2="${pick##*|}"

# Cube lines (0-indexed)
c0='⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀'
c1='⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⡿⠿⠿⠿⢿⣿⣶⣦⣄⡀⠀⠀⠀⠀⠀⠀'
c2='⠀⠀⠀⠀⣠⣴⣿⣿⣿⣿⣿⠏⢀⣤⣤⣤⣤⣿⣿⣿⡿⣿⣦⣄⠀⠀⠀⠀'
c3='⠀⠀⢀⣴⣿⣿⣿⣿⣿⣿⣿⣤⣼⣿⣿⣿⠟⠛⣿⣿⣷⡈⠻⣿⣦⡀⠀⠀'
c4='⠀⢀⣾⡿⠿⠿⠿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣄⣠⣾⣿⣿⣧⣀⣘⣿⣷⡀⠀'
c5='⠀⣾⣿⠁⢰⣿⣷⢀⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠛⠛⠛⠛⠛⠛⣿⣷⠀'
c6='⢰⣿⣯⣤⣤⣭⣥⣼⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⣀⣤⣤⣤⣤⣤⣤⣽⣿⡆'
c7='⢸⣿⡟⢻⡟⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠋⠀⠀⣿⣿⣿⣿⣿⡟⠛⢻⣿⡇'
c8='⠸⣿⣧⣾⣧⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣾⣿⣿⣿⣿⣿⣀⣀⣸⣿⠇'
c9='⠀⢿⣿⣿⣿⣿⣿⡟⠛⠛⠛⣿⣿⡏⠀⢘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀'
c10='⠀⠈⢿⣿⡿⠿⣿⣇⠀⠀⠀⣿⣿⣿⣶⣾⣿⣿⠿⢿⣿⣿⣿⣿⣿⡿⠁⠀'
c11='⠀⠀⠈⠻⣿⣦⣹⣿⣆⠀⠀⢿⣿⡛⠛⠛⠛⠋⣠⣿⣿⣿⣿⣿⠟⠁⠀⠀'
c12='⠀⠀⠀⠀⠙⠻⣿⣿⣿⣦⡀⠘⣿⣇⠀⠀⠀⣴⣿⣿⣿⣿⠟⠋⠀⠀⠀⠀'
c13='⠀⠀⠀⠀⠀⠀⠈⠙⠻⢿⣿⣷⣿⣿⣷⣶⣾⣿⡿⠟⠋⠁⠀⠀⠀⠀⠀⠀'
c14='⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀'

# Box lines — use printf for consistent 42-char inner width
W=40
b_top='╔══════════════════════════════════════════╗'
b_title=$(printf "║  %-${W}s║" "U N I M A T R I X   Z E R O")
b_sep='╠══════════════════════════════════════════╣'
b_l1=$(printf "║  %-${W}s║" "$line1")
b_l2=$(printf "║  %-${W}s║" "$line2")
b_bot='╚══════════════════════════════════════════╝'

gap='   '

# Write to /dev/tty with ANSI escapes to position at top of screen
{
printf '\033[s'          # save cursor position
printf '\033[H'          # move to top-left
printf '\033[0J'         # clear from cursor to end of screen
echo "$c0"
echo "$c1"
echo "$c2"
echo "$c3"
echo "${c4}${gap}${b_top}"
echo "${c5}${gap}${b_title}"
echo "${c6}${gap}${b_sep}"
echo "${c7}${gap}${b_l1}"
echo "${c8}${gap}${b_l2}"
echo "${c9}${gap}${b_bot}"
echo "$c10"
echo "$c11"
echo "$c12"
echo "$c13"
echo "$c14"
echo ""
printf '\033[u'          # restore cursor position
} > /dev/tty
