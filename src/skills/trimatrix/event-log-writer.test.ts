/**
 * Tests for EventLogWriter — append-only file-based event log.
 */

import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { EventLogWriter } from "./event-log-writer.ts";
import type { EventLogEntry } from "./types.ts";

function makeTempSessionId(): string {
  return `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeEntry(seq: number, eventType: string): EventLogEntry {
  return {
    seq,
    timestamp: new Date().toISOString(),
    event: { type: eventType } as EventLogEntry["event"],
    checkpointVersion: "2.7.0",
  };
}

async function cleanupWriter(writer: EventLogWriter): Promise<void> {
  try {
    await rm(writer.filePath, { force: true });
  } catch {
    // best-effort
  }
}

Deno.test("EventLogWriter: append and readAll round-trips entries", async () => {
  const writer = new EventLogWriter(makeTempSessionId());
  try {
    const e1 = makeEntry(1, "plan_submitted");
    const e2 = makeEntry(2, "plan_finalized");
    await writer.append(e1);
    await writer.append(e2);

    const entries = await writer.readAll();
    assertEquals(entries.length, 2);
    assertEquals(entries[0].seq, 1);
    assertEquals(entries[0].event.type, "plan_submitted");
    assertEquals(entries[1].seq, 2);
    assertEquals(entries[1].event.type, "plan_finalized");
  } finally {
    await cleanupWriter(writer);
  }
});

Deno.test("EventLogWriter: readAll on nonexistent file returns empty array", async () => {
  const writer = new EventLogWriter(makeTempSessionId());
  const entries = await writer.readAll();
  assertEquals(entries, []);
});

Deno.test("EventLogWriter: filePath is stable for same sessionId", () => {
  const id = makeTempSessionId();
  const w1 = new EventLogWriter(id);
  const w2 = new EventLogWriter(id);
  assertEquals(w1.filePath, w2.filePath);
  assertEquals(w1.filePath.endsWith(`${id}.ndjson`), true);
});

Deno.test("EventLogWriter: multiple appends preserve order on disk", async () => {
  const writer = new EventLogWriter(makeTempSessionId());
  try {
    for (let i = 1; i <= 5; i++) {
      await writer.append(makeEntry(i, `event_${i}`));
    }
    const entries = await writer.readAll();
    assertEquals(entries.length, 5);
    for (let i = 0; i < 5; i++) {
      assertEquals(entries[i].seq, i + 1);
    }
  } finally {
    await cleanupWriter(writer);
  }
});
