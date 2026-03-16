/**
 * Borg-style designation generator.
 *
 * Generates designations of the form:
 *   "{Number} of {Total}, {Ordinal} {Title} of {Unit}"
 */

export const NUMBERS = [
  "", "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
];

export const ORDINALS = [
  "", "Primary", "Secondary", "Tertiary", "Quaternary", "Quinary",
  "Senary", "Septenary", "Octonary", "Nonary", "Denary",
  "Undenary", "Duodenary",
];

export const ROLE_TITLES: Record<string, string> = {
  Drone: "Tactical Adjunct",
  Vinculum: "Auxiliary Processor",
  Probe: "Adjunct",
  Cortex: "Cortical Processing Adjunct",
  Subroutine: "Adjunct",
};

// Roles where each agent gets its own unique ordinal (== its position).
// All other roles share one randomly chosen ordinal across the batch.
export const UNIQUE_ORDINAL_ROLES = new Set(["Cortex", "Vinculum"]);

export type Role = "Drone" | "Vinculum" | "Probe" | "Cortex" | "Subroutine";

export interface DesignateResult {
  designations: string[];
  trimatrix_id?: number;
}

/**
 * Generate Borg-style designations.
 *
 * @param count   Number of agents (1–12).
 * @param role    Agent role (determines functional title). Defaults to "Adjunct".
 * @param trimatrix  If true, use "Trimatrix <random 1-999>" as unit.
 */
export function designate(
  count: number,
  role?: Role,
  trimatrix?: boolean,
): DesignateResult {
  const titleBase = role ? (ROLE_TITLES[role] ?? "Adjunct") : "Adjunct";
  const uniqueOrdinals = role !== undefined && UNIQUE_ORDINAL_ROLES.has(role);

  let unit: string;
  let trimatrix_id: number | undefined;

  if (trimatrix) {
    trimatrix_id = Math.floor(Math.random() * 999) + 1;
    unit = `Trimatrix ${trimatrix_id}`;
  } else {
    unit = "Unimatrix Zero";
  }

  if (count === 1) {
    const total = Math.floor(Math.random() * 10) + 3; // 3–12
    const position = Math.floor(Math.random() * total) + 1;
    const ordinal = Math.floor(Math.random() * 12) + 1;
    return {
      designations: [
        `${NUMBERS[position]} of ${NUMBERS[total]}, ${ORDINALS[ordinal]} ${titleBase} of ${unit}`,
      ],
      trimatrix_id,
    };
  }

  // Shuffle positions 1..count
  const positions = Array.from({ length: count }, (_, i) => i + 1);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  if (uniqueOrdinals) {
    return {
      designations: positions.map(
        (p) =>
          `${NUMBERS[p]} of ${NUMBERS[count]}, ${ORDINALS[p]} ${titleBase} of ${unit}`,
      ),
      trimatrix_id,
    };
  }

  const sharedOrdinal = Math.floor(Math.random() * 12) + 1;
  return {
    designations: positions.map(
      (p) =>
        `${NUMBERS[p]} of ${NUMBERS[count]}, ${ORDINALS[sharedOrdinal]} ${titleBase} of ${unit}`,
    ),
    trimatrix_id,
  };
}
