/**
 * Append-only file-based event log for trimatrix session crash-recovery.
 *
 * Each entry is written as a single NDJSON line to
 * ~/.brain/trimatrix-events/<sessionId>.ndjson. The file is the source of
 * truth; the checkpoint snapshot is a rebuildable projection.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { EventLogEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function eventLogDir(): string {
  const home = Deno.env.get("HOME") ?? "";
  return join(home, ".brain", "trimatrix-events");
}

function eventLogPath(sessionId: string): string {
  return join(eventLogDir(), `${sessionId}.ndjson`);
}

// ---------------------------------------------------------------------------
// EventLogWriter
// ---------------------------------------------------------------------------

/**
 * Best-effort append-only writer for a single session's event log.
 * Failures are logged to stderr but never rethrown — the writer must never
 * crash the server on a disk error.
 */
export class EventLogWriter {
  private readonly path: string;
  private dirReady = false;
  private _failures = 0;

  constructor(sessionId: string) {
    this.path = eventLogPath(sessionId);
  }

  /**
   * Count of silent append failures observed in this writer's lifetime.
   * Surfaced via `mcp__unimatrix__status` so callers can detect divergence
   * between the in-memory checkpoint and the on-disk log without waiting
   * for `validateCheckpointAgainstLog` to flag a length mismatch.
   */
  get failures(): number {
    return this._failures;
  }

  /** Append one event log entry as a NDJSON line. Best-effort. */
  async append(entry: EventLogEntry): Promise<void> {
    try {
      if (!this.dirReady) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      await appendFile(this.path, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      this._failures++;
      console.error("[trimatrix/event-log] append failed:", err);
    }
  }

  /**
   * Read and parse all entries from the on-disk log.
   * Returns an empty array when the file does not exist or is unreadable.
   */
  async readAll(): Promise<EventLogEntry[]> {
    try {
      const text = await readFile(this.path, "utf-8");
      const entries: EventLogEntry[] = [];
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          entries.push(JSON.parse(trimmed) as EventLogEntry);
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /** Filesystem path of this session's event log file. */
  get filePath(): string {
    return this.path;
  }
}

/**
 * Derive the event log path for a session without constructing a writer.
 * Used for status reporting.
 */
export function sessionEventLogPath(sessionId: string): string {
  return eventLogPath(sessionId);
}
