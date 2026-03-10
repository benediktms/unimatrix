#!/usr/bin/env python3
"""Generate Borg-style designations for drones.

Usage: designate.py <N>
  N = number of drones to generate designations for.

If N > 1, generates "X of N" with shuffled positions.
If N == 1, picks a random total (3-12) and random position to avoid "One of One".
"""

import random
import sys

NUMBERS = [
    "", "One", "Two", "Three", "Four", "Five", "Six",
    "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
]

ORDINALS = [
    "", "Primary", "Secondary", "Tertiary", "Quaternary", "Quinary",
    "Senary", "Septenary", "Octonary", "Nonary", "Denary",
    "Undenary", "Duodenary",
]


def designate(n: int) -> list[str]:
    if n == 1:
        total = random.randint(3, 12)
        position = random.randint(1, total)
        return [
            f"{NUMBERS[position]} of {NUMBERS[total]}, "
            f"{ORDINALS[position]} Adjunct of Unimatrix Zero"
        ]

    positions = list(range(1, n + 1))
    random.shuffle(positions)
    return [
        f"{NUMBERS[p]} of {NUMBERS[n]}, "
        f"{ORDINALS[p]} Adjunct of Unimatrix Zero"
        for p in positions
    ]


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <N>", file=sys.stderr)
        sys.exit(1)

    try:
        n = int(sys.argv[1])
    except ValueError:
        print(f"Error: N must be an integer, got '{sys.argv[1]}'", file=sys.stderr)
        sys.exit(1)

    if n < 1 or n > 12:
        print(f"Error: N must be between 1 and 12, got {n}", file=sys.stderr)
        sys.exit(1)

    for line in designate(n):
        print(line)


if __name__ == "__main__":
    main()
