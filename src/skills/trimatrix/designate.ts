/**
 * Borg-style designation generator.
 *
 * Generates designations of the form:
 *   "{Number} of {Total}, {Ordinal} {Title} of {Unit}"
 */

/**
 * Derives a stable Trimatrix ID in [1, 999] from a session id (and optionally a git commit).
 * Pure FNV-1a 32-bit. The gitCommit parameter is reserved for callers that already hold
 * commit context; the MCP designate handler currently does not pass it because the handler
 * is synchronous and a `git rev-parse` subprocess would force async. Session id alone
 * provides cross-session uniqueness across the [1, 999] codomain.
 */
export function deriveTrimatrixId(sessionId: string, gitCommit?: string): number {
  // FNV-1a 32-bit: offset basis and prime are standard constants.
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET = 0x811c9dc5;

  const input = gitCommit ? `${sessionId}\0${gitCommit}` : sessionId;
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply mod 2^32 using unsigned 32-bit arithmetic.
    hash = (Math.imul(hash, FNV_PRIME) >>> 0);
  }
  // Map to [1, 999].
  return (hash % 999) + 1;
}

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
  DRONE = "DRONE",
  SENTINEL = "SENTINEL",
  PROBE = "PROBE",
  DESIGNATE = "DESIGNATE",
  LOCUTUS = "LOCUTUS",
}

export const ROLE_TITLES: Record<Role, string> = {
  [Role.ADJUNCT]: "Adjunct: Generic Drone",
  [Role.DRONE]: "Drone Protocol",
  [Role.SENTINEL]: "Sentinel Protocol",
  [Role.PROBE]: "Probe Protocol",
  [Role.DESIGNATE]: "Designate Protocol",
  [Role.LOCUTUS]: "Locutus Protocol",
};

// Roles where each agent gets its own unique ordinal (== its position).
// All other roles share one randomly chosen ordinal across the batch.
export const UNIQUE_ORDINAL_ROLES = new Set<Role>([
  Role.DESIGNATE,
  Role.SENTINEL,
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
  const titleBase = ROLE_TITLES[role] ?? ROLE_TITLES[Role.ADJUNCT];
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

  // Locutus always receives a fixed designation regardless of count.
  if (role === Role.LOCUTUS) {
    return { designations: ["Locutus of Borg"], trimatrix_id: resolved_trimatrix_id };
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
