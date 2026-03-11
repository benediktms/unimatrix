#!/usr/bin/env python3
"""Generate Borg-style designations for agents.

Usage: designate.py <N> [--role Drone|Vinculum|Probe|Cortex] [--trimatrix] [--swarm]
  N           = number of agents to generate designations for.
  --role      = agent type (determines Borg functional title).
  --trimatrix = use "Trimatrix <random>" instead of "Unimatrix Zero".
  --swarm     = legacy alias for --trimatrix.

Role → functional title mapping:
  Drone    → Tactical Adjunct
  Vinculum → Auxiliary Processor
  Probe    → Adjunct
  Cortex   → Cortical Processing Adjunct
  (default) → Adjunct

If N > 1, generates "X of N" with shuffled positions.
If N == 1, picks a random total (3-12) and random position to avoid "One of One".

Ordinal behaviour:
  - Batch agents (Drone, Probe, Subroutine, default) share one randomly chosen
    ordinal across the entire batch (e.g. all "Tertiary").
  - Individual agents (Cortex, Vinculum) get a unique ordinal per agent.
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
    "Drone": "Tactical Adjunct",
    "Vinculum": "Auxiliary Processor",
    "Probe": "Adjunct",
    "Cortex": "Cortical Processing Adjunct",
    "Subroutine": "Adjunct",
}

# Roles where each agent gets its own unique ordinal.
# All other roles share one randomly chosen ordinal across the batch.
UNIQUE_ORDINAL_ROLES = {"Cortex", "Vinculum"}


def designate(n: int, role: str | None = None, swarm: bool = False) -> list[str]:
    title_base = ROLE_TITLES.get(role, "Adjunct") if role else "Adjunct"
    unique_ordinals = role in UNIQUE_ORDINAL_ROLES

    if swarm:
        unit = f"Trimatrix {random.randint(1, 999)}"
    else:
        unit = "Unimatrix Zero"

    if n == 1:
        total = random.randint(3, 12)
        position = random.randint(1, total)
        ordinal = random.randint(1, 12)
        return [
            f"{NUMBERS[position]} of {NUMBERS[total]}, "
            f"{ORDINALS[ordinal]} {title_base} of {unit}"
        ]

    positions = list(range(1, n + 1))
    random.shuffle(positions)

    if unique_ordinals:
        return [
            f"{NUMBERS[p]} of {NUMBERS[n]}, "
            f"{ORDINALS[p]} {title_base} of {unit}"
            for p in positions
        ]

    shared_ordinal = random.randint(1, 12)
    return [
        f"{NUMBERS[p]} of {NUMBERS[n]}, "
        f"{ORDINALS[shared_ordinal]} {title_base} of {unit}"
        for p in positions
    ]


def main():
    parser = argparse.ArgumentParser(description="Generate Borg-style designations")
    parser.add_argument("n", type=int, help="Number of designations to generate (1-12)")
    parser.add_argument("--role", choices=["Drone", "Vinculum", "Probe", "Cortex", "Subroutine"],
                        help="Agent type (determines Borg functional title)")
    parser.add_argument("--trimatrix", action="store_true",
                        help="Use Trimatrix <random> instead of Unimatrix Zero")
    parser.add_argument("--swarm", action="store_true",
                        help="Legacy alias for --trimatrix")
    args = parser.parse_args()

    if args.n < 1 or args.n > 12:
        print(f"Error: N must be between 1 and 12, got {args.n}", file=sys.stderr)
        sys.exit(1)

    use_trimatrix = args.trimatrix or args.swarm
    for line in designate(args.n, role=args.role, swarm=use_trimatrix):
        print(line)


if __name__ == "__main__":
    main()
