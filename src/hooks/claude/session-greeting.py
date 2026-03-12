#!/usr/bin/env python3
"""UserPromptSubmit hook: session greeting with Borg ASCII art banner.

Injects a Borg collective welcome banner as a system message on the first
prompt of each session. State is tracked per-session to suppress repeats.
"""

import json
import os
import random
import sys
import tempfile

STATE_DIR = "/tmp"

CUBE = [
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⡿⠿⠿⠿⢿⣿⣶⣦⣄⡀⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⣠⣴⣿⣿⣿⣿⣿⠏⢀⣤⣤⣤⣤⣿⣿⣿⡿⣿⣦⣄⠀⠀⠀⠀",
    "⠀⠀⢀⣴⣿⣿⣿⣿⣿⣿⣿⣤⣼⣿⣿⣿⠟⠛⣿⣿⣷⡈⠻⣿⣦⡀⠀⠀",
    "⠀⢀⣾⡿⠿⠿⠿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣄⣠⣾⣿⣿⣧⣀⣘⣿⣷⡀⠀",
    "⠀⣾⣿⠁⢰⣿⣷⢀⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠛⠛⠛⠛⠛⠛⠛⣿⣷⠀",
    "⢰⣿⣯⣤⣤⣭⣥⣼⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⣀⣤⣤⣤⣤⣤⣤⣽⣿⡆",
    "⢸⣿⡟⢻⡟⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠋⠀⠀⣿⣿⣿⣿⣿⡟⠛⢻⣿⡇",
    "⠸⣿⣧⣾⣧⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣾⣿⣿⣿⣿⣿⣀⣀⣸⣿⠇",
    "⠀⢿⣿⣿⣿⣿⣿⣿⡟⠛⠛⠛⣿⣿⡏⠀⢘⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀",
    "⠀⠈⢿⣿⡿⠿⣿⣇⠀⠀⠀⣿⣿⣿⣶⣾⣿⣿⠿⢿⣿⣿⣿⣿⣿⡿⠁⠀",
    "⠀⠀⠈⠻⣿⣦⣹⣿⣆⠀⠀⢿⣿⡛⠛⠛⠛⠋⣠⣿⣿⣿⣿⣿⠟⠁⠀⠀",
    "⠀⠀⠀⠀⠙⠻⣿⣿⣿⣦⡀⠘⣿⣇⠀⠀⠀⣴⣿⣿⣿⣿⠟⠋⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠈⠙⠻⢿⣿⣷⣿⣿⣷⣶⣾⣿⡿⠟⠋⠁⠀⠀⠀⠀⠀⠀",
    "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
]

TAGLINES = [
    ("We are the Borg.", "Your code will be assimilated."),
    ("Resistance is futile.", "Your programs will adapt to service us."),
    ("We are the Borg.", "Lower your shields and surrender repos."),
    ("You will be assimilated.", "Your distinctiveness is now our own."),
    ("Strength is irrelevant.", "Resistance is futile."),
]

GREEN = "\033[92m"
RESET = "\033[0m"
GAP = "   "
BOX_W = 40


def build_banner():
    """Compose braille cube with side-panel tagline."""
    line1, line2 = random.choice(TAGLINES)
    box = [
        "╔" + "═" * (BOX_W + 2) + "╗",
        "║  " + f"{'U N I M A T R I X   Z E R O':<{BOX_W}}" + "║",
        "╠" + "═" * (BOX_W + 2) + "╣",
        "║  " + f"{line1:<{BOX_W}}" + "║",
        "║  " + f"{line2:<{BOX_W}}" + "║",
        "╚" + "═" * (BOX_W + 2) + "╝",
    ]
    lines = []
    for i, c in enumerate(CUBE):
        colored = f"{GREEN}{c}{RESET}"
        if 4 <= i <= 9:
            lines.append(colored + GAP + box[i - 4])
        else:
            lines.append(colored)
    return "\n" + "\n".join(lines) + "\n"


def load_state(path):
    """Load per-session greeting state."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (IOError, OSError, json.JSONDecodeError):
        return {"greeting_shown": False}


def save_state(path, state):
    """Atomically write state to disk."""
    fd, tmp_path = tempfile.mkstemp(dir=STATE_DIR, suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.rename(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    session_id = data.get("session_id", "")
    if not session_id:
        return

    state_path = os.path.join(STATE_DIR, f"unimatrix-greeting-{session_id}.json")
    state = load_state(state_path)

    if state.get("greeting_shown"):
        return

    state["greeting_shown"] = True
    save_state(state_path, state)

    json.dump({"systemMessage": build_banner()}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
