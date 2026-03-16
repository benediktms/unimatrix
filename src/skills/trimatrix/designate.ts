/**
 * Borg-style designation generator.
 *
 * Generates designations of the form:
 *   "{Number} of {Total}, {Ordinal} {Title} of {Unit}"
 */

export const NUMBERS = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

export const ORDINALS = [
  "",
  "Primary",
  "Secondary",
  "Tertiary",
  "Quaternary",
  "Quinary",
  "Senary",
  "Septenary",
  "Octonary",
  "Nonary",
  "Denary",
  "Undenary",
  "Duodenary",
];

export enum Role {
  ADJUNCT = "ADJUNCT",
  ASSIMILATION = "ASSIMILATION",
  VALIDATION = "VALIDATION",
  RECONNAISSANCE = "RECONNAISSANCE",
  TACTICAL_ANALYSIS = "TACTICAL_ANALYSIS",
  CLOSURE = "CLOSURE",
}

export const ROLE_TITLES: Record<Role, string> = {
  [Role.ADJUNCT]: "Adjunct: Generic Drone",
  [Role.ASSIMILATION]: "Adjunct: Assimilation Protocol",
  [Role.VALIDATION]: "Adjunct: Validation Protocol",
  [Role.RECONNAISSANCE]: "Adjunct: Reconnaissance Protocol",
  [Role.TACTICAL_ANALYSIS]: "Adjunct: Tactical Analysis Protocol",
  [Role.CLOSURE]: "Adjunct: Closure Protocol",
};

// Roles where each agent gets its own unique ordinal (== its position).
// All other roles share one randomly chosen ordinal across the batch.
export const UNIQUE_ORDINAL_ROLES = new Set<Role>([
  Role.TACTICAL_ANALYSIS,
  Role.VALIDATION,
]);

export interface DesignateResult {
  designations: string[];
  trimatrix_id?: number;
}

/**
 * Generate Borg-style designations.
 *
 * @param count        Number of agents (1–12).
 * @param role         Agent role (determines functional title). Defaults to "Adjunct".
 * @param trimatrix    If true, use "Trimatrix <random 1-999>" as unit.
 * @param trimatrix_id If provided and trimatrix is true, pin this ID instead of generating a random one.
 */
export function designate(
  count: number,
  role: Role = Role.ADJUNCT,
  trimatrix?: boolean,
  trimatrix_id?: number,
): DesignateResult {
  const titleBase = ROLE_TITLES[role];
  const uniqueOrdinals = role !== undefined && UNIQUE_ORDINAL_ROLES.has(role);

  let unit: string;
  let resolved_trimatrix_id: number | undefined;

  if (trimatrix) {
    resolved_trimatrix_id =
      trimatrix_id !== undefined
        ? trimatrix_id
        : Math.floor(Math.random() * 999) + 1;
    unit = `Trimatrix ${resolved_trimatrix_id}`;
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
      trimatrix_id: resolved_trimatrix_id,
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
      trimatrix_id: resolved_trimatrix_id,
    };
  }

  const sharedOrdinal = Math.floor(Math.random() * 12) + 1;
  return {
    designations: positions.map(
      (p) =>
        `${NUMBERS[p]} of ${NUMBERS[count]}, ${ORDINALS[sharedOrdinal]} ${titleBase} of ${unit}`,
    ),
    trimatrix_id: resolved_trimatrix_id,
  };
}
