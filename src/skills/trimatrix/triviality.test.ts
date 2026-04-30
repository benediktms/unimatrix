/**
 * Unit tests for the triviality classifier.
 *
 * Coverage:
 *   - Happy path: all inputs trivial → TRIVIAL
 *   - Empty / zero inputs → TRIVIAL
 *   - Boundary: locDelta=30 → TRIVIAL; locDelta=31 → NON_TRIVIAL
 *   - Each individual non-trivial criterion → NON_TRIVIAL (5 tests)
 */

import { assertEquals } from "jsr:@std/assert";
import { classifyTriviality } from "./triviality.ts";
import type { TrivialityInput } from "./triviality.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fully trivial baseline input. */
const TRIVIAL_BASE: TrivialityInput = {
  locDelta: 10,
  fileCount: 1,
  riskKeywords: 0,
  crossPackage: false,
  crossBrain: false,
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test("classifyTriviality — all criteria met → TRIVIAL", () => {
  assertEquals(classifyTriviality(TRIVIAL_BASE), "TRIVIAL");
});

// ---------------------------------------------------------------------------
// Zero / empty inputs
// ---------------------------------------------------------------------------

Deno.test("classifyTriviality — zero locDelta and fileCount=1 → TRIVIAL", () => {
  const input: TrivialityInput = {
    locDelta: 0,
    fileCount: 1,
    riskKeywords: 0,
    crossPackage: false,
    crossBrain: false,
  };
  assertEquals(classifyTriviality(input), "TRIVIAL");
});

// ---------------------------------------------------------------------------
// locDelta boundary
// ---------------------------------------------------------------------------

Deno.test("classifyTriviality — locDelta=30 (at boundary) → TRIVIAL", () => {
  const input: TrivialityInput = { ...TRIVIAL_BASE, locDelta: 30 };
  assertEquals(classifyTriviality(input), "TRIVIAL");
});

Deno.test("classifyTriviality — locDelta=31 (above boundary) → NON_TRIVIAL", () => {
  const input: TrivialityInput = { ...TRIVIAL_BASE, locDelta: 31 };
  assertEquals(classifyTriviality(input), "NON_TRIVIAL");
});

// ---------------------------------------------------------------------------
// Individual non-trivial criteria
// ---------------------------------------------------------------------------

Deno.test("classifyTriviality — fileCount=2 → NON_TRIVIAL", () => {
  const input: TrivialityInput = { ...TRIVIAL_BASE, fileCount: 2 };
  assertEquals(classifyTriviality(input), "NON_TRIVIAL");
});

Deno.test("classifyTriviality — riskKeywords=1 → NON_TRIVIAL", () => {
  const input: TrivialityInput = { ...TRIVIAL_BASE, riskKeywords: 1 };
  assertEquals(classifyTriviality(input), "NON_TRIVIAL");
});

Deno.test("classifyTriviality — crossPackage=true → NON_TRIVIAL", () => {
  const input: TrivialityInput = { ...TRIVIAL_BASE, crossPackage: true };
  assertEquals(classifyTriviality(input), "NON_TRIVIAL");
});

Deno.test("classifyTriviality — crossBrain=true → NON_TRIVIAL", () => {
  const input: TrivialityInput = { ...TRIVIAL_BASE, crossBrain: true };
  assertEquals(classifyTriviality(input), "NON_TRIVIAL");
});
