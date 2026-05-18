// Unit tests for the standalone embed client used by pi + openclaw.
// Mirrors the pattern in embeddings-client.test.ts: real Unix-socket
// stub daemon, per-test mkdtemp isolation, no model loading.
//
// 11 edge cases from issue #178:
//   1.  daemon binary missing → NULL, no spawn attempt
//   2.  binary + no socket + no pidfile → spawn → embed
//   3.  socket alive → connect direct → embed
//   4.  stale socket (no daemon listening) → cleanup + spawn → embed
//   5.  dead PID in pidfile → cleanup + spawn
//   6.  live PID in pidfile, socket missing → wait, no SIGTERM
//   7.  two callers race → O_EXCL: one spawns, other waits
//   8.  spawn() throws → NULL
//   9.  daemon spawned but never opens socket → 5s timeout → NULL
//   10. embed request times out → NULL
//   11. daemon returns unknown-op error → NULL

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  tryEmbedStandalone,
  SHARED_DAEMON_PATH,
  _setSpawnImpl,
} from "../../src/embeddings/standalone-embed-client.js";
import type { DaemonRequest, DaemonResponse } from "../../src/embeddings/protocol.js";

let servers: Server[] = [];
let tmpDirs: string[] = [];

afterEach(() => {
  for (const s of servers) try { s.close(); } catch { /* */ }
  servers = [];
  for (const d of tmpDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  tmpDirs = [];
  _setSpawnImpl(null);
  vi.restoreAllMocks();
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hvm-standalone-embed-"));
  tmpDirs.push(d);
  return d;
}

function uid(): string {
  return String(process.getuid?.() ?? "test");
}

function pathsFor(dir: string): { socket: string; pid: string } {
  return {
    socket: join(dir, `hivemind-embed-${uid()}.sock`),
    pid: join(dir, `hivemind-embed-${uid()}.pid`),
  };
}

async function startFakeDaemon(
  dir: string,
  handler: (req: DaemonRequest) => DaemonResponse,
): Promise<Server> {
  const { socket: sockPath } = pathsFor(dir);
  const srv = createServer((sock: Socket) => {
    let buf = "";
    sock.setEncoding("utf-8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line) as DaemonRequest;
        const resp = handler(req);
        sock.write(JSON.stringify(resp) + "\n");
      }
    });
    sock.on("error", () => { /* */ });
  });
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  return srv;
}

describe("tryEmbedStandalone", () => {
  it("exports SHARED_DAEMON_PATH under the canonical install location", () => {
    expect(SHARED_DAEMON_PATH).toMatch(/\.hivemind\/embed-deps\/embed-daemon\.js$/);
  });

  // Case 3 — socket alive, happy path.
  it("connects directly and returns the embedding vector when the daemon is up", async () => {
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => {
      if (req.op === "embed") return { id: req.id, embedding: [0.4, 0.5, 0.6] };
      return { id: req.id, error: "unexpected op" };
    });
    const vec = await tryEmbedStandalone("hello world", "document", {
      socketDir: dir,
      requestTimeoutMs: 500,
      daemonEntry: "/dev/null",  // never used: socket is up
    });
    expect(vec).toEqual([0.4, 0.5, 0.6]);
  });

  // Case 1 — binary missing → no spawn, return NULL.
  it("returns null and never spawns when the daemon entry does not exist", async () => {
    const dir = makeTmpDir();
    let spawnCalls = 0;
    _setSpawnImpl(() => {
      spawnCalls += 1;
      return makeFakeChild();
    });

    const vec = await tryEmbedStandalone("anything", "document", {
      socketDir: dir,
      daemonEntry: join(dir, "no-such-daemon.js"), // missing
      requestTimeoutMs: 50,
      spawnWaitMs: 150,
    });

    expect(vec).toBeNull();
    expect(spawnCalls).toBe(0);
    // No pidfile should be left behind either.
    expect(existsSync(pathsFor(dir).pid)).toBe(false);
  });

  // Case 2 — binary present, no socket, no pidfile → spawn → embed.
  // We stub `spawn` to start the fake daemon synchronously, then return a
  // ChildProcess-shaped mock. That exercises the full spawn + wait + embed
  // path without launching a real Node subprocess.
  it("spawns the daemon when the socket is absent and embeds successfully once it appears", async () => {
    const dir = makeTmpDir();
    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "// placeholder so existsSync() is true");

    let spawnCalls = 0;
    _setSpawnImpl(() => {
      spawnCalls += 1;
      // Bring the fake daemon up after a short delay so waitForSocket has to poll.
      setTimeout(() => {
        void startFakeDaemon(dir, (req) =>
          req.op === "embed" ? { id: req.id, embedding: [1, 2, 3] } : { id: req.id, error: "nope" },
        );
      }, 30);
      return makeFakeChild();
    });

    const vec = await tryEmbedStandalone("doc", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 500,
      spawnWaitMs: 2000,
    });

    expect(vec).toEqual([1, 2, 3]);
    expect(spawnCalls).toBe(1);
  });

  // Case 4 — stale socket file (no daemon listening) + cleanup.
  // The real daemon unlinks the stale socket itself on bind; from the
  // client's POV this looks like "connect refused → spawn path → wait".
  it("falls into the spawn path when the socket file is stale (no daemon)", async () => {
    const dir = makeTmpDir();
    const { socket: sockPath } = pathsFor(dir);
    writeFileSync(sockPath, ""); // orphan socket file, nothing listening
    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    let spawnCalls = 0;
    _setSpawnImpl(() => {
      spawnCalls += 1;
      setTimeout(() => {
        // Real daemon would unlink stale socket on bind. Simulate that.
        try { rmSync(sockPath); } catch { /* */ }
        void startFakeDaemon(dir, (req) =>
          req.op === "embed" ? { id: req.id, embedding: [0.7] } : { id: req.id, error: "nope" },
        );
      }, 30);
      return makeFakeChild();
    });

    const vec = await tryEmbedStandalone("doc", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 500,
      spawnWaitMs: 2000,
    });
    expect(vec).toEqual([0.7]);
    expect(spawnCalls).toBeGreaterThanOrEqual(1);
  });

  // Case 5 — pidfile points to a dead PID → cleanup + spawn.
  it("cleans up a pidfile with a dead PID before spawning", async () => {
    const dir = makeTmpDir();
    const { pid: pidPath } = pathsFor(dir);
    writeFileSync(pidPath, "2147483646"); // guaranteed-dead PID

    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    let spawnCalls = 0;
    _setSpawnImpl(() => {
      spawnCalls += 1;
      setTimeout(() => {
        void startFakeDaemon(dir, (req) =>
          req.op === "embed" ? { id: req.id, embedding: [9] } : { id: req.id, error: "nope" },
        );
      }, 30);
      return makeFakeChild();
    });

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 500,
      spawnWaitMs: 2000,
    });

    expect(vec).toEqual([9]);
    expect(spawnCalls).toBe(1);
  });

  // Case 6 — live PID in pidfile, socket missing → respect, don't SIGTERM.
  it("does not spawn or SIGTERM when an alive pidfile owner is present but the socket never appears", async () => {
    const dir = makeTmpDir();
    const { pid: pidPath } = pathsFor(dir);
    writeFileSync(pidPath, String(process.pid)); // our own pid → alive

    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    let spawnCalls = 0;
    _setSpawnImpl(() => { spawnCalls += 1; return makeFakeChild(); });
    const killSpy = vi.spyOn(process, "kill");

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 50,
      spawnWaitMs: 200, // intentionally short — daemon never comes up
    });

    expect(vec).toBeNull();
    expect(spawnCalls).toBe(0);
    // The only allowed kill is the liveness probe `kill(pid, 0)` — never SIGTERM.
    for (const call of killSpy.mock.calls) {
      expect(call[1]).toBe(0);
    }
    // Pidfile is left untouched (live owner).
    expect(existsSync(pidPath)).toBe(true);
  });

  // Case 7 — two callers race; O_EXCL ensures one wins. Sufficient guard:
  // spawn is called at most once, both callers get the same vector.
  it("only spawns once when two callers race; the loser connects to the same daemon", async () => {
    const dir = makeTmpDir();
    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    let spawned = 0;
    _setSpawnImpl(() => {
      spawned += 1;
      if (spawned === 1) {
        setTimeout(() => {
          void startFakeDaemon(dir, (req) =>
            req.op === "embed" ? { id: req.id, embedding: [42] } : { id: req.id, error: "nope" },
          );
        }, 30);
      }
      return makeFakeChild();
    });

    const [a, b] = await Promise.all([
      tryEmbedStandalone("one", "document", {
        socketDir: dir,
        daemonEntry: fakeEntry,
        requestTimeoutMs: 500,
        spawnWaitMs: 2000,
      }),
      tryEmbedStandalone("two", "document", {
        socketDir: dir,
        daemonEntry: fakeEntry,
        requestTimeoutMs: 500,
        spawnWaitMs: 2000,
      }),
    ]);

    expect(a).toEqual([42]);
    expect(b).toEqual([42]);
    expect(spawned).toBe(1);
  });

  // Case 8 — spawn() throws.
  it("returns null when spawn() throws and rolls back the pidfile", async () => {
    const dir = makeTmpDir();
    const { pid: pidPath } = pathsFor(dir);
    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    _setSpawnImpl(() => { throw new Error("EAGAIN"); });

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 50,
      spawnWaitMs: 200,
    });

    expect(vec).toBeNull();
    // Pidfile rolled back so the next attempt isn't permanently blocked.
    expect(existsSync(pidPath)).toBe(false);
  });

  // Case 9 — daemon spawned but never opens the socket.
  it("returns null after spawnWaitMs when the daemon fails to listen", async () => {
    const dir = makeTmpDir();
    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    _setSpawnImpl(() => {
      // Spawn "succeeds" but no daemon listens.
      return makeFakeChild();
    });

    const start = Date.now();
    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 50,
      spawnWaitMs: 250,
    });
    const elapsed = Date.now() - start;

    expect(vec).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1500);
  });

  // Case 10 — daemon accepts but never replies; request times out.
  it("returns null on request timeout (daemon accepts but never replies)", async () => {
    const dir = makeTmpDir();
    const { socket: sockPath } = pathsFor(dir);
    const srv = createServer((_s: Socket) => { /* accept and hang */ });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: "/dev/null",
      requestTimeoutMs: 80,
      spawnWaitMs: 200,
    });
    expect(vec).toBeNull();
  });

  // Case 11 — daemon returns `error: "unknown op"` (older protocol).
  it("returns null when the daemon responds with an error (e.g. unknown op)", async () => {
    const dir = makeTmpDir();
    await startFakeDaemon(dir, (req) => ({ id: req.id, error: "unknown op" }));

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: "/dev/null",
      requestTimeoutMs: 500,
    });
    expect(vec).toBeNull();
  });

  // Extra guard: garbage pidfile is treated as stale (mirrors client.ts).
  it("treats a garbage pidfile as stale and proceeds to spawn", async () => {
    const dir = makeTmpDir();
    const { pid: pidPath } = pathsFor(dir);
    writeFileSync(pidPath, "not-a-number");

    const fakeEntry = join(dir, "daemon-marker.js");
    writeFileSync(fakeEntry, "");

    let spawnCalls = 0;
    _setSpawnImpl(() => {
      spawnCalls += 1;
      setTimeout(() => {
        void startFakeDaemon(dir, (req) =>
          req.op === "embed" ? { id: req.id, embedding: [3.14] } : { id: req.id, error: "nope" },
        );
      }, 30);
      return makeFakeChild();
    });

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: fakeEntry,
      requestTimeoutMs: 500,
      spawnWaitMs: 2000,
    });
    expect(vec).toEqual([3.14]);
    expect(spawnCalls).toBe(1);
  });

  // Extra guard: malformed JSON from the daemon doesn't throw.
  it("returns null when the daemon writes malformed JSON", async () => {
    const dir = makeTmpDir();
    const { socket: sockPath } = pathsFor(dir);
    const srv = createServer((sock: Socket) => {
      sock.setEncoding("utf-8");
      sock.on("data", () => sock.write("not-json\n"));
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: "/dev/null",
      requestTimeoutMs: 500,
    });
    expect(vec).toBeNull();
  });

  // Extra guard: socket closes mid-request → null without hanging.
  it("returns null fast when the daemon FINs without responding", async () => {
    const dir = makeTmpDir();
    const { socket: sockPath } = pathsFor(dir);
    const srv = createServer((sock: Socket) => {
      sock.on("data", () => sock.end());
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(sockPath, resolve));

    const start = Date.now();
    const vec = await tryEmbedStandalone("x", "document", {
      socketDir: dir,
      daemonEntry: "/dev/null",
      requestTimeoutMs: 30_000,
    });
    const elapsed = Date.now() - start;
    expect(vec).toBeNull();
    expect(elapsed).toBeLessThan(1000);
  });

  it("respects the kind parameter end-to-end", async () => {
    const dir = makeTmpDir();
    const seen: string[] = [];
    await startFakeDaemon(dir, (req) => {
      if (req.op === "embed") {
        seen.push(req.kind);
        return { id: req.id, embedding: [0] };
      }
      return { id: req.id, error: "nope" };
    });
    await tryEmbedStandalone("q", "query", { socketDir: dir, daemonEntry: "/dev/null", requestTimeoutMs: 500 });
    expect(seen).toEqual(["query"]);
  });

  it("uses default option values when called with only positional args", async () => {
    // Just exercises the `opts.x ?? default` branches. No daemon is up at
    // the real /tmp socket, so this must return null without throwing —
    // and quickly, since SHARED_DAEMON_PATH typically doesn't exist on a
    // CI runner. We can't hard-assert on filesystem state outside the
    // tmpdir, so we settle for "doesn't throw, returns null".
    //
    // If the developer's machine HAS a real shared daemon at
    // SHARED_DAEMON_PATH and it answers, the call returns a vector
    // instead of null — both outcomes are valid; we only assert one of
    // those two.
    if (existsSync(SHARED_DAEMON_PATH) && statSync(SHARED_DAEMON_PATH).isFile()) {
      // Can't mock the canonical install — skip the strict assertion.
      return;
    }
    const vec = await tryEmbedStandalone("hello", "document");
    expect(vec).toBeNull();
  });
});

/**
 * Build a minimal object that looks enough like a `ChildProcess` for the
 * client to call `.unref()` on. We never wait on its lifecycle, so
 * stdout/stderr/stdin/pid are not exercised.
 */
function makeFakeChild(): ChildProcess {
  return {
    unref() { /* */ },
    pid: 999999,
  } as unknown as ChildProcess;
}
