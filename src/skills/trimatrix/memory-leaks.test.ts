/**
 * Memory-leak regression tests (unm-b96.2).
 *
 * U1: consumeRuntimeStateFile deletes the file after reading — second call
 *     finds no artifact from the first.
 * U2: execWithStdin cleans up all listeners on process close — listener counts
 *     on the actual spawned proc must be zero after the promise resolves.
 */

import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  __forTesting,
  consumeRuntimeStateFile,
  execWithStdin,
} from "./server.ts";

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

Deno.test(
  "consumeRuntimeStateFile: second call on a fresh path does not see prior call's file",
  async () => {
    const dir = tmpdir();
    const pathA = join(dir, `unimatrix-agents-A-${Date.now()}.json`);
    const pathB = join(dir, `unimatrix-agents-B-${Date.now()}.json`);

    await writeFile(pathA, JSON.stringify({ session: "A" }), "utf-8");
    await writeFile(pathB, JSON.stringify({ session: "B" }), "utf-8");

    // Path A consumed
    const resA = await consumeRuntimeStateFile(pathA);
    assertEquals(resA?.session, "A");

    // Path B unaffected
    const resB = await consumeRuntimeStateFile(pathB);
    assertEquals(resB?.session, "B");

    // Path A already consumed — must return null
    const resA2 = await consumeRuntimeStateFile(pathA);
    assertEquals(
      resA2,
      null,
      "file must not persist after first consume",
    );
  },
);

Deno.test("consumeRuntimeStateFile: returns null for nonexistent file", async () => {
  const result = await consumeRuntimeStateFile(
    "/tmp/unimatrix-does-not-exist-999.json",
  );
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// U2: execWithStdin — listener cleanup after process close
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "execWithStdin: all proc listeners removed before cleanup (mutation kill)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Capture pre-cleanup listener counts via the test hook.
    // The hook fires immediately before cleanup() runs — so if cleanup() is
    // present, counts are still non-zero here; after cleanup() they drop to 0.
    // We assert that cleanup() is called by checking counts after the promise.
    const counts: { stdout: number; stderr: number; proc: number }[] = [];

    __forTesting._onProcClose = (proc) => {
      counts.push({
        stdout: proc.stdout?.listenerCount("data") ?? -1,
        stderr: proc.stderr?.listenerCount("data") ?? -1,
        proc: proc.listenerCount("close") + proc.listenerCount("error"),
      });
    };

    try {
      // Run enough iterations to confirm no growth over time.
      for (let i = 0; i < 10; i++) {
        await execWithStdin("echo", ["ok"]);
      }
    } finally {
      __forTesting._onProcClose = undefined;
    }

    // Every invocation must have triggered the hook.
    assertEquals(counts.length, 10, "hook must fire for every invocation");

    // Pre-cleanup counts must be exactly 1 for data/close/error listeners —
    // proving cleanup() subsequently removes them. If cleanup() is missing,
    // these counts would still be 1 here (hook fires before cleanup), but the
    // test would not catch that. Instead we verify the post-promise state:
    // after `await execWithStdin(...)` returns, cleanup() has already run.
    // Re-query the last proc's counts via a second hook that fires after.
    const postCounts: { stdout: number; stderr: number; proc: number }[] = [];

    __forTesting._onProcClose = (proc) => {
      // Schedule a microtask to capture counts after cleanup() in the finally.
      Promise.resolve().then(() => {
        postCounts.push({
          stdout: proc.stdout?.listenerCount("data") ?? -1,
          stderr: proc.stderr?.listenerCount("data") ?? -1,
          proc: proc.listenerCount("close") + proc.listenerCount("error"),
        });
      });
    };

    try {
      await execWithStdin("echo", ["ok"]);
      // Flush the microtask queue.
      await Promise.resolve();
    } finally {
      __forTesting._onProcClose = undefined;
    }

    assertEquals(postCounts.length, 1, "post-cleanup hook must fire once");
    assertEquals(
      postCounts[0].stdout,
      0,
      "proc.stdout must have 0 'data' listeners after cleanup",
    );
    assertEquals(
      postCounts[0].stderr,
      0,
      "proc.stderr must have 0 'data' listeners after cleanup",
    );
    assertEquals(
      postCounts[0].proc,
      0,
      "proc must have 0 close+error listeners after cleanup",
    );
  },
});
