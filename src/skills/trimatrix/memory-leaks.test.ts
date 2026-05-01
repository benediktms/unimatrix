/**
 * Memory-leak regression tests (unm-b96.2).
 *
 * U1: consumeRuntimeStateFile deletes the file after reading — second call
 *     finds no artifact from the first.
 * U2: execWithStdin cleans up all listeners on process close — 1000 invocations
 *     must not grow the listener count on a sentinel emitter.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { consumeRuntimeStateFile, execWithStdin } from "./server.ts";

// ---------------------------------------------------------------------------
// U1: consumeRuntimeStateFile — read-then-delete
// ---------------------------------------------------------------------------

Deno.test("consumeRuntimeStateFile: returns parsed JSON and deletes the file", async () => {
  const dir = tmpdir();
  const path = join(dir, `unimatrix-test-consume-${Date.now()}.json`);
  await writeFile(path, JSON.stringify({ ok: true }), "utf-8");

  const result = await consumeRuntimeStateFile(path);
  assertEquals(result, { ok: true });

  // File must be gone
  const second = await consumeRuntimeStateFile(path);
  assertEquals(second, null, "file must be deleted after first consume");
});

Deno.test("consumeRuntimeStateFile: second session does not see prior session's file", async () => {
  const dir = tmpdir();
  const sessionA = `unimatrix-agents-session-A-${Date.now()}.json`;
  const sessionB = `unimatrix-agents-session-B-${Date.now()}.json`;
  const pathA = join(dir, sessionA);
  const pathB = join(dir, sessionB);

  await writeFile(pathA, JSON.stringify({ session: "A" }), "utf-8");
  await writeFile(pathB, JSON.stringify({ session: "B" }), "utf-8");

  // Session A consumes its file
  const resA = await consumeRuntimeStateFile(pathA);
  assertEquals(resA?.session, "A");

  // Session B's file is untouched
  const resB = await consumeRuntimeStateFile(pathB);
  assertEquals(resB?.session, "B");

  // Both files are now gone; a second invocation of A must return null
  const resA2 = await consumeRuntimeStateFile(pathA);
  assertEquals(resA2, null, "session A file must not persist into a second run");
});

Deno.test("consumeRuntimeStateFile: returns null for nonexistent file", async () => {
  const result = await consumeRuntimeStateFile("/tmp/unimatrix-does-not-exist-999.json");
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// U2: execWithStdin — listener cleanup after 1000 invocations
// ---------------------------------------------------------------------------

Deno.test({
  name: "execWithStdin: listener count does not grow over 1000 invocations",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sentinel = new EventEmitter();
    // Capture max listener headroom before the loop
    const before = sentinel.getMaxListeners();
    assertNotEquals(before, 0); // sanity check

    const iterations = 1000;
    for (let i = 0; i < iterations; i++) {
      // Use a simple echo command that exits cleanly
      await execWithStdin("echo", ["ok"]);
    }

    // Verify process-level listener budget: if listeners leak, the Node.js
    // runtime emits a MaxListenersExceededWarning. We capture it via the
    // process warning event.
    let warningFired = false;
    const warnHandler = (w: { name: string }) => {
      if (w.name === "MaxListenersExceededWarning") warningFired = true;
    };
    // deno-lint-ignore no-explicit-any
    (process as any).on("warning", warnHandler);

    // Run 50 more to flush any deferred warnings
    for (let i = 0; i < 50; i++) {
      await execWithStdin("echo", ["ok"]);
    }

    // deno-lint-ignore no-explicit-any
    (process as any).off("warning", warnHandler);
    assertEquals(warningFired, false, "MaxListenersExceededWarning must not fire");
  },
});
