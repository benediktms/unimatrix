#!/usr/bin/env python3
"""Generate Borg-style designations for agents.

Usage: designate.py <N> [--role drone|vinculum|probe] [--swarm]
  N      = number of agents to generate designations for.
  --role = agent type (determines Borg functional title).
  --swarm = use "Trimatrix <random>" instead of "Unimatrix Zero".

Role → functional title mapping:
  drone    → Tactical Adjunct
  vinculum → Auxiliary Processor
  probe    → Adjunct (generic)
  (default) → Adjunct

If N > 1, generates "X of N" with shuffled positions.
If N == 1, picks a random total (3-12) and random position to avoid "One of One".
"""

import argparse
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

ROLE_TITLES = {
    "drone": "Tactical Adjunct",
    "vinculum": "Auxiliary Processor",
    "probe": "Adjunct",
}


def designate(n: int, role: str | None = None, swarm: bool = False) -> list[str]:
    title_base = ROLE_TITLES.get(role, "Adjunct") if role else "Adjunct"

    if swarm:
        unit = f"Trimatrix {random.randint(1, 999)}"
    else:
        unit = "Unimatrix Zero"

    if n == 1:
        total = random.randint(3, 12)
        position = random.randint(1, total)
        return [
            f"{NUMBERS[position]} of {NUMBERS[total]}, "
            f"{ORDINALS[position]} {title_base} of {unit}"
        ]

    positions = list(range(1, n + 1))
    random.shuffle(positions)
    return [
        f"{NUMBERS[p]} of {NUMBERS[n]}, "
        f"{ORDINALS[p]} {title_base} of {unit}"
        for p in positions
    ]


def main():
    parser = argparse.ArgumentParser(description="Generate Borg-style designations")
    parser.add_argument("n", type=int, help="Number of designations to generate (1-12)")
    parser.add_argument("--role", choices=["drone", "vinculum", "probe"],
                        help="Agent type (determines Borg functional title)")
    parser.add_argument("--swarm", action="store_true",
                        help="Use Trimatrix <random> instead of Unimatrix Zero")
    args = parser.parse_args()

    if args.n < 1 or args.n > 12:
        print(f"Error: N must be between 1 and 12, got {args.n}", file=sys.stderr)
        sys.exit(1)

    for line in designate(args.n, role=args.role, swarm=args.swarm):
        print(line)


if __name__ == "__main__":
    main()
