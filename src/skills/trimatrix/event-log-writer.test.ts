/**
 * Tests for EventLogWriter — append-only file-based event log.
 *
 * Each test runs under a HOME override pointing to a fresh `Deno.makeTempDir`,
 * so the writer never touches the developer's real `~/.brain/`. The wider
 * `--allow-env --allow-read --allow-write` permission grant in
 * `deno.json :: test:trimatrix` is bounded by this scoping — writes only land
 * inside the tmp directory and the tmp directory is removed in `finally`.
 */

import { assertEquals } from "@std/assert";
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

/**
 * Run `fn` with HOME pointing at a fresh tempdir; restore HOME and clean up
 * the tempdir afterwards. Keeps writer-test side-effects out of `~/.brain/`.
 */
async function withTmpHome(
  fn: (writer: EventLogWriter) => Promise<void>,
): Promise<void> {
  const origHome = Deno.env.get("HOME");
  const tmpDir = await Deno.makeTempDir({ prefix: "unm-evt-log-test-" });
  Deno.env.set("HOME", tmpDir);
  const writer = new EventLogWriter(makeTempSessionId());
  try {
    await fn(writer);
  } finally {
    if (origHome !== undefined) {
      Deno.env.set("HOME", origHome);
    } else {
      Deno.env.delete("HOME");
    }
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

Deno.test("EventLogWriter: append and readAll round-trips entries", async () => {
  await withTmpHome(async (writer) => {
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
  });
});

Deno.test("EventLogWriter: readAll on nonexistent file returns empty array", async () => {
  await withTmpHome(async (writer) => {
    const entries = await writer.readAll();
    assertEquals(entries, []);
  });
});

Deno.test("EventLogWriter: filePath is stable for same sessionId", () => {
  const id = makeTempSessionId();
  const w1 = new EventLogWriter(id);
  const w2 = new EventLogWriter(id);
  assertEquals(w1.filePath, w2.filePath);
  assertEquals(w1.filePath.endsWith(`${id}.ndjson`), true);
});

Deno.test("EventLogWriter: multiple appends preserve order on disk", async () => {
  await withTmpHome(async (writer) => {
    for (let i = 1; i <= 5; i++) {
      await writer.append(makeEntry(i, `event_${i}`));
    }
    const entries = await writer.readAll();
    assertEquals(entries.length, 5);
    for (let i = 0; i < 5; i++) {
      assertEquals(entries[i].seq, i + 1);
    }
  });
});

Deno.test("EventLogWriter: failures starts at zero", () => {
  const writer = new EventLogWriter(makeTempSessionId());
  assertEquals(writer.failures, 0);
});
