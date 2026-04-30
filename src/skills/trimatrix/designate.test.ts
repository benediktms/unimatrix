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
 * - Shared ordinals: batch roles (Drone, Probe, Locutus) share one ordinal
 * - Unique ordinals: Designate/Sentinel get ordinal == their position
 * - Format validation: regex match on designation string
 * - One-of-One avoidance: probabilistic, tested over 50 iterations
 */

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  deriveTrimatrixId,
  designate,
  NUMBERS,
  ORDINALS,
  Role,
  ROLE_TITLES,
  UNIQUE_ORDINAL_ROLES,
} from "./designate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full designation format: "<Word> of <Word>, <Word> <Title...> of <Unit>" */
const DESIGNATION_RE = /^[A-Z][a-z]+ of [A-Z][a-z]+, [A-Z][a-z]+ .+ of .+$/;

// ---------------------------------------------------------------------------
// N=1
// ---------------------------------------------------------------------------

Deno.test("N=1: returns exactly 1 designation", () => {
  const { designations } = designate(1, Role.DRONE);
  assertEquals(designations.length, 1);
});

Deno.test("N=1: designation matches format", () => {
  const { designations } = designate(1, Role.DRONE);
  assertMatch(designations[0], DESIGNATION_RE);
});

Deno.test("N=1: never produces 'One of One' over 50 runs", () => {
  for (let i = 0; i < 50; i++) {
    const { designations } = designate(1, Role.DRONE);
    const d = designations[0];
    if (d.startsWith("One of One")) {
      throw new Error(`Got "One of One" on iteration ${i}: ${d}`);
    }
  }
});

Deno.test("N=1: position is within a valid range (not zero, not > 12)", () => {
  for (let i = 0; i < 20; i++) {
    const { designations } = designate(1, Role.DRONE);
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
  const { designations } = designate(5, Role.DRONE);
  assertEquals(designations.length, 5);
});

Deno.test("N=5: all positions are unique", () => {
  const { designations } = designate(5, Role.DRONE);
  const positionWords = designations.map((d) => d.split(" of ")[0]);
  const unique = new Set(positionWords);
  assertEquals(unique.size, 5, `Duplicate positions found: ${positionWords}`);
});

Deno.test("N=5: all positions are valid numbers 1–5", () => {
  const { designations } = designate(5, Role.DRONE);
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
  const { designations } = designate(12, Role.DRONE);
  assertEquals(designations.length, 12);
});

Deno.test("N=12: all positions are unique and span 1–12", () => {
  const { designations } = designate(12, Role.DRONE);
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
  Role.DRONE,
  Role.SENTINEL,
  Role.PROBE,
  Role.DESIGNATE,
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
  const { designations, trimatrix_id } = designate(3, Role.DRONE, true);
  assertNotEquals(trimatrix_id, undefined);
  for (const d of designations) {
    assertMatch(d, /Trimatrix \d+$/);
  }
});

Deno.test("trimatrix=true: trimatrix_id is between 1 and 999", () => {
  for (let i = 0; i < 20; i++) {
    const { trimatrix_id } = designate(1, Role.DRONE, true);
    if (trimatrix_id === undefined || trimatrix_id < 1 || trimatrix_id > 999) {
      throw new Error(`trimatrix_id out of range: ${trimatrix_id}`);
    }
  }
});

Deno.test("trimatrix=true: unit in designation matches trimatrix_id", () => {
  const { designations, trimatrix_id } = designate(3, Role.DRONE, true);
  for (const d of designations) {
    assertMatch(d, new RegExp(`Trimatrix ${trimatrix_id}$`));
  }
});

Deno.test("trimatrix=false: designation contains 'Unimatrix Zero'", () => {
  const { designations, trimatrix_id } = designate(3, Role.DRONE, false);
  assertEquals(trimatrix_id, undefined);
  for (const d of designations) {
    assertMatch(d, /Unimatrix Zero$/);
  }
});

Deno.test("trimatrix omitted: designation contains 'Unimatrix Zero'", () => {
  const { designations, trimatrix_id } = designate(3, Role.DRONE);
  assertEquals(trimatrix_id, undefined);
  for (const d of designations) {
    assertMatch(d, /Unimatrix Zero$/);
  }
});

// ---------------------------------------------------------------------------
// Shared vs unique ordinals
// ---------------------------------------------------------------------------

const SHARED_ORDINAL_ROLES: Role[] = [
  Role.DRONE,
  Role.PROBE,
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

for (const role of [Role.DESIGNATE, Role.SENTINEL]) {
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
  "UNIQUE_ORDINAL_ROLES contains Designate and Sentinel",
  () => {
    assertEquals(UNIQUE_ORDINAL_ROLES.has(Role.DESIGNATE), true);
    assertEquals(UNIQUE_ORDINAL_ROLES.has(Role.SENTINEL), true);
    assertEquals(UNIQUE_ORDINAL_ROLES.has(Role.DRONE), false);
    assertEquals(UNIQUE_ORDINAL_ROLES.has(Role.PROBE), false);
    assertEquals(UNIQUE_ORDINAL_ROLES.has(Role.LOCUTUS), false);
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
      Role.DRONE,
      true,
      42,
    );
    assertEquals(trimatrix_id, 42);
    for (const d of designations) {
      assertMatch(d, /Trimatrix 42$/);
    }
  },
);

// ---------------------------------------------------------------------------
// Locutus special handling
// ---------------------------------------------------------------------------

Deno.test("Locutus: always returns 'Locutus of Borg' regardless of count", () => {
  for (const count of [1, 3, 5, 12]) {
    const { designations } = designate(count, Role.LOCUTUS);
    assertEquals(designations.length, 1);
    assertEquals(designations[0], "Locutus of Borg");
  }
});

Deno.test("Locutus: returns trimatrix_id when trimatrix=true", () => {
  const { designations, trimatrix_id } = designate(1, Role.LOCUTUS, true, 77);
  assertEquals(designations.length, 1);
  assertEquals(designations[0], "Locutus of Borg");
  assertEquals(trimatrix_id, 77);
});

// ---------------------------------------------------------------------------
// deriveTrimatrixId
// ---------------------------------------------------------------------------

Deno.test("deriveTrimatrixId: output is in [1, 999]", () => {
  const id = deriveTrimatrixId("trimatrix-2026-01-01-abc1");
  if (id < 1 || id > 999) {
    throw new Error(`deriveTrimatrixId out of range: ${id}`);
  }
});

Deno.test("deriveTrimatrixId: same input produces same output (deterministic)", () => {
  const sessionId = "trimatrix-2026-01-01-abc1";
  const a = deriveTrimatrixId(sessionId);
  const b = deriveTrimatrixId(sessionId);
  assertEquals(a, b, "Expected identical outputs for the same session id");
});

Deno.test("deriveTrimatrixId: git commit mix-in is deterministic", () => {
  const sessionId = "trimatrix-2026-01-01-xyz9";
  const a = deriveTrimatrixId(sessionId, "a1b2c3d");
  const b = deriveTrimatrixId(sessionId, "a1b2c3d");
  assertEquals(a, b);
});

Deno.test("deriveTrimatrixId: session + commit differs from session alone", () => {
  const sessionId = "trimatrix-2026-01-01-xyz9";
  const withCommit = deriveTrimatrixId(sessionId, "a1b2c3d");
  const without = deriveTrimatrixId(sessionId);
  assertNotEquals(withCommit, without);
});

Deno.test("deriveTrimatrixId: cross-commit divergence for fixed session", () => {
  // For a fixed session, different git commits should produce different IDs.
  // Codomain is [1, 999] — some collisions are expected. Allow at most 1 in 100 pairs.
  const sessionId = "trimatrix-2026-01-01-xyz9";
  let collisions = 0;
  const trials = 100;
  for (let i = 0; i < trials; i++) {
    const commitA = Math.random().toString(36).slice(2, 9);
    const commitB = Math.random().toString(36).slice(2, 9);
    if (commitA === commitB) continue; // skip degenerate case
    const idA = deriveTrimatrixId(sessionId, commitA);
    const idB = deriveTrimatrixId(sessionId, commitB);
    if (idA === idB) collisions++;
  }
  if (collisions > 1) {
    throw new Error(
      `deriveTrimatrixId: too many cross-commit collisions for fixed session: ${collisions}/${trials}`,
    );
  }
});

Deno.test("deriveTrimatrixId: output range [1,999] for 1000 random session ids", () => {
  for (let i = 0; i < 1000; i++) {
    const sessionId = `trimatrix-session-${
      Math.random().toString(36).slice(2)
    }-${i}`;
    const id = deriveTrimatrixId(sessionId);
    if (id < 1 || id > 999) {
      throw new Error(
        `deriveTrimatrixId out of range: ${id} for session ${sessionId}`,
      );
    }
  }
});

Deno.test("deriveTrimatrixId: two concurrent sessions produce different ids with >99% probability (birthday)", () => {
  // With 999 buckets and 2 independent sessions, P(match) = 1/999 ≈ 0.1%.
  // We draw 200 non-overlapping pairs and verify fewer than 1% collide.
  let collisions = 0;
  const trials = 200;
  for (let i = 0; i < trials; i++) {
    const s1 = `trimatrix-session-A-${
      Math.random().toString(36).slice(2)
    }-${i}`;
    const s2 = `trimatrix-session-B-${
      Math.random().toString(36).slice(2)
    }-${i}`;
    if (deriveTrimatrixId(s1) === deriveTrimatrixId(s2)) {
      collisions++;
    }
  }
  const rate = collisions / trials;
  if (rate >= 0.01) {
    throw new Error(
      `Pairwise collision rate too high: ${collisions}/${trials} = ${
        (rate * 100).toFixed(2)
      }%`,
    );
  }
});

Deno.test("deriveTrimatrixId: distinct ids across 200 unique session ids (distribution check)", () => {
  // Verify the hash is not degenerate: 200 unique sessions should produce
  // at least 150 distinct ids (expecting ~150 due to birthday paradox in [1,999]).
  const ids = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const sessionId = `trimatrix-session-${i}-${
      Math.random().toString(36).slice(2)
    }`;
    ids.add(deriveTrimatrixId(sessionId));
  }
  if (ids.size < 150) {
    throw new Error(
      `Too few distinct ids: ${ids.size} from 200 inputs — hash may be degenerate`,
    );
  }
});
