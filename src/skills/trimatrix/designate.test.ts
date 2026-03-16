/**
 * Tests for the designate function.
 *
 * Coverage:
 * - N=1: exactly 1 designation, no "One of One"
 * - N=5: exactly 5 designations, all unique positions
 * - N=12: exactly 12 designations (max boundary)
 * - Role mapping: title embedded in designation
 * - trimatrix=true: contains "Trimatrix <number>", trimatrix_id present
 * - trimatrix=false/omitted: contains "Unimatrix Zero", trimatrix_id absent
 * - Shared ordinals: batch roles (Assimilation, Reconnaissance, Closure) share one ordinal
 * - Unique ordinals: TacticalAnalysis/Validation get ordinal == their position
 * - Format validation: regex match on designation string
 * - One-of-One avoidance: probabilistic, tested over 50 iterations
 */

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  designate,
  NUMBERS,
  ORDINALS,
  ROLE_TITLES,
  UNIQUE_ORDINAL_ROLES,
} from "./designate.ts";
import type { Role } from "./designate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full designation format: "<Word> of <Word>, <Word> <Title...> of <Unit>" */
const DESIGNATION_RE = /^[A-Z][a-z]+ of [A-Z][a-z]+, [A-Z][a-z]+ .+ of .+$/;

// ---------------------------------------------------------------------------
// N=1
// ---------------------------------------------------------------------------

Deno.test("N=1: returns exactly 1 designation", () => {
  const { designations } = designate(1, "Assimilation");
  assertEquals(designations.length, 1);
});

Deno.test("N=1: designation matches format", () => {
  const { designations } = designate(1, "Assimilation");
  assertMatch(designations[0], DESIGNATION_RE);
});

Deno.test("N=1: never produces 'One of One' over 50 runs", () => {
  for (let i = 0; i < 50; i++) {
    const { designations } = designate(1, "Assimilation");
    const d = designations[0];
    if (d.startsWith("One of One")) {
      throw new Error(`Got "One of One" on iteration ${i}: ${d}`);
    }
  }
});

Deno.test("N=1: position is within a valid range (not zero, not > 12)", () => {
  for (let i = 0; i < 20; i++) {
    const { designations } = designate(1, "Assimilation");
    const parts = designations[0].split(" of ");
    const position = parts[0];
    // Must be a valid NUMBERS entry (non-empty)
    assertNotEquals(position, "");
    const idx = NUMBERS.indexOf(position);
    assertNotEquals(idx, -1, `Unknown position word: ${position}`);
    // Total is the word before the comma
    const totalWord = parts[1].split(",")[0];
    const totalIdx = NUMBERS.indexOf(totalWord);
    assertNotEquals(totalIdx, -1, `Unknown total word: ${totalWord}`);
    // Position must be <= total
    if (idx > totalIdx) {
      throw new Error(
        `Position ${position} (${idx}) > total ${totalWord} (${totalIdx}): ${
          designations[0]
        }`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// N=5
// ---------------------------------------------------------------------------

Deno.test("N=5: returns exactly 5 designations", () => {
  const { designations } = designate(5, "Assimilation");
  assertEquals(designations.length, 5);
});

Deno.test("N=5: all positions are unique", () => {
  const { designations } = designate(5, "Assimilation");
  const positionWords = designations.map((d) => d.split(" of ")[0]);
  const unique = new Set(positionWords);
  assertEquals(unique.size, 5, `Duplicate positions found: ${positionWords}`);
});

Deno.test("N=5: all positions are valid numbers 1–5", () => {
  const { designations } = designate(5, "Assimilation");
  const validSet = new Set(NUMBERS.slice(1, 6));
  for (const d of designations) {
    const pos = d.split(" of ")[0];
    if (!validSet.has(pos)) {
      throw new Error(`Invalid position word: ${pos} in "${d}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// N=12 (max boundary)
// ---------------------------------------------------------------------------

Deno.test("N=12: returns exactly 12 designations", () => {
  const { designations } = designate(12, "Assimilation");
  assertEquals(designations.length, 12);
});

Deno.test("N=12: all positions are unique and span 1–12", () => {
  const { designations } = designate(12, "Assimilation");
  const positionWords = designations.map((d) => d.split(" of ")[0]);
  const unique = new Set(positionWords);
  assertEquals(unique.size, 12);
  for (const word of NUMBERS.slice(1)) {
    if (!unique.has(word)) {
      throw new Error(`Missing position word: ${word}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Role title mapping
// ---------------------------------------------------------------------------

const ROLES: Role[] = [
  "Assimilation",
  "Validation",
  "Reconnaissance",
  "TacticalAnalysis",
  "Closure",
];

for (const role of ROLES) {
  const expectedTitle = ROLE_TITLES[role];
  Deno.test(`Role mapping: ${role} → "${expectedTitle}"`, () => {
    const { designations } = designate(3, role);
    for (const d of designations) {
      if (!d.includes(expectedTitle)) {
        throw new Error(
          `Expected title "${expectedTitle}" in "${d}" for role ${role}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Trimatrix unit
// ---------------------------------------------------------------------------

Deno.test("trimatrix=true: designation contains 'Trimatrix' + number", () => {
  const { designations, trimatrix_id } = designate(3, "Assimilation", true);
  assertNotEquals(trimatrix_id, undefined);
  for (const d of designations) {
    assertMatch(d, /Trimatrix \d+$/);
  }
});

Deno.test("trimatrix=true: trimatrix_id is between 1 and 999", () => {
  for (let i = 0; i < 20; i++) {
    const { trimatrix_id } = designate(1, "Assimilation", true);
    if (trimatrix_id === undefined || trimatrix_id < 1 || trimatrix_id > 999) {
      throw new Error(`trimatrix_id out of range: ${trimatrix_id}`);
    }
  }
});

Deno.test("trimatrix=true: unit in designation matches trimatrix_id", () => {
  const { designations, trimatrix_id } = designate(3, "Assimilation", true);
  for (const d of designations) {
    assertMatch(d, new RegExp(`Trimatrix ${trimatrix_id}$`));
  }
});

Deno.test("trimatrix=false: designation contains 'Unimatrix Zero'", () => {
  const { designations, trimatrix_id } = designate(3, "Assimilation", false);
  assertEquals(trimatrix_id, undefined);
  for (const d of designations) {
    assertMatch(d, /Unimatrix Zero$/);
  }
});

Deno.test("trimatrix omitted: designation contains 'Unimatrix Zero'", () => {
  const { designations, trimatrix_id } = designate(3, "Assimilation");
  assertEquals(trimatrix_id, undefined);
  for (const d of designations) {
    assertMatch(d, /Unimatrix Zero$/);
  }
});

// ---------------------------------------------------------------------------
// Shared vs unique ordinals
// ---------------------------------------------------------------------------

const SHARED_ORDINAL_ROLES: Role[] = [
  "Assimilation",
  "Reconnaissance",
  "Closure",
];

for (const role of SHARED_ORDINAL_ROLES) {
  Deno.test(
    `Shared ordinals: ${role} N=5 — all designations share the same ordinal`,
    () => {
      // Run multiple times because the shared ordinal is randomly chosen.
      for (let iter = 0; iter < 10; iter++) {
        const { designations } = designate(5, role);
        // Extract the ordinal word (first word after the comma+space).
        const ordinals = designations.map((d) => {
          const afterComma = d.split(", ")[1];
          return afterComma.split(" ")[0];
        });
        const uniqueOrdinals = new Set(ordinals);
        assertEquals(
          uniqueOrdinals.size,
          1,
          `Expected shared ordinal for ${role} but got: ${ordinals}`,
        );
      }
    },
  );
}

for (const role of ["TacticalAnalysis", "Validation"] as Role[]) {
  Deno.test(`Unique ordinals: ${role} N=5 — ordinal equals position`, () => {
    const { designations } = designate(5, role);
    for (const d of designations) {
      const posWord = d.split(" of ")[0];
      const posIdx = NUMBERS.indexOf(posWord);
      const afterComma = d.split(", ")[1];
      const ordinalWord = afterComma.split(" ")[0];
      const expectedOrdinal = ORDINALS[posIdx];
      assertEquals(
        ordinalWord,
        expectedOrdinal,
        `Expected ordinal "${expectedOrdinal}" for position ${posWord} but got "${ordinalWord}" in "${d}"`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Format validation (regex)
// ---------------------------------------------------------------------------

Deno.test("Format validation: all roles N=3 match designation regex", () => {
  for (const role of ROLES) {
    const { designations } = designate(3, role);
    for (const d of designations) {
      assertMatch(d, DESIGNATION_RE, `Invalid format for role ${role}: "${d}"`);
    }
  }
});

Deno.test("Format validation: N=1 no-role matches designation regex", () => {
  const { designations } = designate(1);
  assertMatch(designations[0], DESIGNATION_RE);
});

// ---------------------------------------------------------------------------
// UNIQUE_ORDINAL_ROLES set export
// ---------------------------------------------------------------------------

Deno.test(
  "UNIQUE_ORDINAL_ROLES contains TacticalAnalysis and Validation",
  () => {
    assertEquals(UNIQUE_ORDINAL_ROLES.has("TacticalAnalysis"), true);
    assertEquals(UNIQUE_ORDINAL_ROLES.has("Validation"), true);
    assertEquals(UNIQUE_ORDINAL_ROLES.has("Assimilation"), false);
    assertEquals(UNIQUE_ORDINAL_ROLES.has("Reconnaissance"), false);
    assertEquals(UNIQUE_ORDINAL_ROLES.has("Closure"), false);
  },
);

// ---------------------------------------------------------------------------
// trimatrix_id pin parameter
// ---------------------------------------------------------------------------

Deno.test(
  "trimatrix_id pin: all designations end with 'Trimatrix 42' and trimatrix_id === 42",
  () => {
    const { designations, trimatrix_id } = designate(
      3,
      "Assimilation",
      true,
      42,
    );
    assertEquals(trimatrix_id, 42);
    for (const d of designations) {
      assertMatch(d, /Trimatrix 42$/);
    }
  },
);
