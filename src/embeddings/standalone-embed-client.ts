// Read-only embedding client for agents that don't bundle a daemon of
// their own (pi extension source, openclaw plugin). Talks to the same
// per-user Unix socket as `src/embeddings/client.ts`, and — when the
// socket is absent — auto-spawns the canonical shared daemon at
// `~/.hivemind/embed-deps/embed-daemon.js` (deposited by
// `hivemind embeddings install`).
//
// Differences from `client.ts`:
//   - No hello/handshake. These callers don't recycle stuck daemons:
//     they connect, embed, and disconnect. Recycling is the hot-path
//     client's job — having two recycle paths would race.
//   - No singleton, no notification side-effects. Each call is
//     independent and returns null on any failure.
//   - No SIGTERM on stale-pidfile-with-live-PID. Same PID-reuse risk
//     PR #168 fixed in client.ts: if the socket is gone the daemon
//     process is also gone, and the PID we captured may already have
//     been recycled by the OS to an unrelated user process.
//
// Hard requirement: callers MUST treat a null return as "skip embedding
// column" — never block the write path on us.

import { connect, type Socket } from "node:net";
import { spawn as realSpawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import {
  openSync, closeSync, writeSync, unlinkSync, existsSync, readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  pidPathFor,
  socketPathFor,
  type EmbedKind,
  type EmbedRequest,
  type EmbedResponse,
} from "./protocol.js";

/** Canonical location populated by `hivemind embeddings install`. */
export const SHARED_DAEMON_PATH = join(homedir(), ".hivemind", "embed-deps", "embed-daemon.js");

// Swappable spawn implementation. Has two legitimate callers:
//
//   1. Unit tests, because ESM bindings for `node:child_process.spawn`
//      can't be spied on directly (the namespace is non-configurable).
//
//   2. Bundle environments that stub out `node:child_process` (most
//      notably the openclaw plugin — see esbuild.config.mjs's
//      `stub-unused-child-process` plugin). Those bundles must call
//      `_setSpawnImpl(realSpawn)` once at startup with the real
//      function obtained via `createRequire`, otherwise spawn() is a
//      no-op stub and the daemon never starts.
//
// Default is the statically-imported `realSpawn` — correct for any
// non-stubbed environment.
type SpawnFn = (cmd: string, args: ReadonlyArray<string>, opts: SpawnOptions) => ChildProcess;
let _spawn: SpawnFn = realSpawn as SpawnFn;

export interface StandaloneEmbedOptions {
  /** Override socket directory. Tests pass a per-test tmpdir for isolation. */
  socketDir?: string;
  /** Override daemon entry path. Defaults to SHARED_DAEMON_PATH. */
  daemonEntry?: string;
  /** Per-attempt connect/send timeout. Defaults to DEFAULT_CLIENT_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** Total time to wait for a freshly spawned daemon's socket. Default 5s. */
  spawnWaitMs?: number;
}

function getUid(): string {
  /* v8 ignore next 2 — `process.getuid` is always present on Linux/macOS test runners. */
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid !== undefined ? String(uid) : (process.env.USER ?? "default");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number(raw);
    if (!pid || Number.isNaN(pid)) return null;
    return pid;
  } catch {
    /* v8 ignore next — pidfile is unlinked between the EEXIST that
       triggered this read and the read itself. Sub-millisecond window. */
    return null;
  }
}

function connectOnce(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    /* v8 ignore next 4 — Unix-socket connect always fires connect or error
       immediately; the timeout exists as a last-resort safety net. */
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(to);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}

function sendAndWait(sock: Socket, req: EmbedRequest, timeoutMs: number): Promise<EmbedResponse> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error("request timeout"));
    }, timeoutMs);
    sock.setEncoding("utf-8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(to);
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as EmbedResponse);
      } catch (e) {
        reject(e as Error);
      }
    });
    sock.on("error", (e) => { clearTimeout(to); reject(e); });
    // Daemon FIN without sending a response would otherwise hang the
    // promise until timeoutMs — surface as a fast reject instead.
    sock.on("end", () => { clearTimeout(to); reject(new Error("connection closed without response")); });
    sock.write(JSON.stringify(req) + "\n");
  });
}

/**
 * Attempt to spawn the daemon under an O_EXCL pidfile lock. Returns true
 * if THIS process owns the spawn; false if someone else already does
 * (winner of the race) or no spawn could happen (deps missing / spawn
 * throw — pidfile is cleaned up in those cases).
 *
 * Race protocol mirrors client.ts: we write our own pid into the file as
 * a transient placeholder so concurrent callers don't see an empty
 * pidfile and treat it as stale. The daemon itself overwrites the file
 * with its own pid during startup (see daemon.ts).
 */
function trySpawnDaemon(daemonEntry: string, pidPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(pidPath, "wx", 0o600);
    writeSync(fd, String(process.pid));
  } catch {
    // Pidfile already exists. If it's stale (dead pid / garbage),
    // clean and retry once — same recovery client.ts uses.
    const existing = readPidFile(pidPath);
    if (existing !== null && isPidAlive(existing)) {
      // Live owner — let the caller wait for socket without spawning.
      return false;
    }
    try { unlinkSync(pidPath); } catch { /* already gone */ }
    try {
      fd = openSync(pidPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
    } catch {
      /* v8 ignore next 3 — sub-millisecond race window: another caller
         cleaned + claimed the pidfile between our unlink and re-open. */
      return false;
    }
  }

  try {
    const child = _spawn(process.execPath, [daemonEntry], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    // spawn() itself threw (rare: missing execPath, EAGAIN). Roll
    // pidfile back so the next caller can try.
    try { unlinkSync(pidPath); } catch { /* */ }
    return false;
  } finally {
    try { closeSync(fd); } catch { /* */ }
  }
}

async function waitForSocket(socketPath: string, deadline: number, connectTimeoutMs: number): Promise<Socket | null> {
  let delay = 30;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 300);
    if (!existsSync(socketPath)) continue;
    try {
      return await connectOnce(socketPath, connectTimeoutMs);
    } catch {
      // Socket appeared but daemon hasn't accepted yet — keep polling.
    }
  }
  return null;
}

/**
 * Request an embedding from the shared daemon, spawning it if necessary.
 * Returns `null` on any failure (no daemon binary, spawn fails, request
 * times out, daemon error, etc). NEVER throws.
 *
 * Semantics by case (matches the issue #178 edge-case matrix):
 *
 *  - daemon binary at `daemonEntry` missing → null, no spawn attempt
 *  - socket alive → connect + embed directly
 *  - stale socket (no daemon) → spawn; daemon unlinks the stale socket
 *    on bind (see daemon.ts start())
 *  - dead PID in pidfile → cleanup pidfile + spawn
 *  - live PID in pidfile but no socket → respect it, wait. No SIGTERM
 *    (PID reuse risk; same lesson as the recycle path in client.ts)
 *  - two callers race → O_EXCL `wx` lets one spawn; the loser waits
 *  - spawn fails / daemon never opens socket → 5s timeout → null
 *  - request times out / daemon returns `error` (e.g. unknown op) → null
 */
export async function tryEmbedStandalone(
  text: string,
  kind: EmbedKind,
  opts: StandaloneEmbedOptions = {},
): Promise<number[] | null> {
  const socketDir = opts.socketDir ?? "/tmp";
  const daemonEntry = opts.daemonEntry ?? SHARED_DAEMON_PATH;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  const spawnWaitMs = opts.spawnWaitMs ?? 5000;

  const uid = getUid();
  const socketPath = socketPathFor(uid, socketDir);
  const pidPath = pidPathFor(uid, socketDir);

  let sock: Socket | null = null;
  try {
    sock = await connectOnce(socketPath, requestTimeoutMs);
  } catch {
    // Socket missing or daemon refused — fall through to the spawn path.
  }

  if (!sock) {
    if (!existsSync(daemonEntry)) {
      // Case 1: binary not installed. Caller falls back to NULL.
      return null;
    }
    // trySpawnDaemon is the single source of truth for the "spawn vs.
    // wait" decision. It internally respects live pidfile owners (case
    // 6/7), cleans up dead PIDs (case 5), and rolls back on failure
    // (case 8) — no outer pre-check that could shadow its branches.
    trySpawnDaemon(daemonEntry, pidPath);
    const deadline = Date.now() + spawnWaitMs;
    sock = await waitForSocket(socketPath, deadline, requestTimeoutMs);
    if (!sock) return null; // Case 9: daemon never came up within the window.
  }

  try {
    const req: EmbedRequest = { op: "embed", id: "1", kind, text };
    const resp = await sendAndWait(sock, req, requestTimeoutMs);
    if (resp.error || !resp.embedding || !Array.isArray(resp.embedding)) {
      // Case 11: older daemon → `{ error: "unknown op" }`, or daemon-side
      // failure. Always graceful.
      return null;
    }
    return resp.embedding;
  } catch {
    // Case 10: request timeout / connection died mid-request.
    return null;
  } finally {
    try { sock.end(); } catch { /* */ }
  }
}

// ── Spawn-impl injection ────────────────────────────────────────────────────

/**
 * Replace the internal spawn implementation. Underscore-prefixed and NOT
 * part of the public API. See the comment on `_spawn` for the two
 * legitimate callers (unit tests + bundle environments stubbing
 * `node:child_process`).
 *
 * Pass `null` to reset to the statically-imported default (used by tests
 * in their `afterEach`).
 */
export function _setSpawnImpl(fn: SpawnFn | null): void {
  _spawn = fn ?? (realSpawn as SpawnFn);
}
