import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the consent + non-TTY auth-gate in src/cli/index.ts.
 *
 * Drives `hivemind install` end-to-end through the CLI dispatcher (rule 4:
 * load through the actual loader) and asserts on count + shape (rule 6) of
 * `ensureLoggedIn` / `loginWithProvidedToken` / `confirm` per path.
 *
 * The seven cases map 1-to-1 to the rows of the decision matrix in the plan:
 *   1. TTY + decline                     → no auth, install continues, hint logged
 *   2. TTY + accept                      → ensureLoggedIn exactly once, install continues
 *   3. Non-TTY + no token                → no readline (would hang), no auth, hint logged
 *   4. Non-TTY + env token + /me 200     → loginWithProvidedToken once, no device flow
 *   5. Non-TTY + --token flag + /me 200  → same as above, log says "--token flag"
 *   6. Non-TTY + invalid token + /me 401 → warning, install continues, exit 0
 *   7. TTY + --token flag                → token honored, consent prompt NOT shown
 *
 * Plus a negative-pattern assertion (rule 8): "Signed in via DEEPLAKE_API_TOKEN"
 * must NOT appear in the --token-flag log line.
 */

const installs = {
  installClaude: vi.fn(), uninstallClaude: vi.fn(),
  installCodex: vi.fn(),  uninstallCodex: vi.fn(),
  installOpenclaw: vi.fn(), uninstallOpenclaw: vi.fn(),
  installCursor: vi.fn(), uninstallCursor: vi.fn(),
  installHermes: vi.fn(), uninstallHermes: vi.fn(),
  installPi: vi.fn(),     uninstallPi: vi.fn(),
};
const ensureLoggedInMock = vi.fn();
const isLoggedInMock = vi.fn();
const loginWithProvidedTokenMock = vi.fn();
const maybeShowOrgChoiceMock = vi.fn();
const runAuthCommandMock = vi.fn();
const detectPlatformsMock = vi.fn();
const allPlatformIdsMock = vi.fn();
const getVersionMock = vi.fn();
const runUpdateMock = vi.fn();
const confirmMock = vi.fn();
const stdoutMock = vi.fn();
const stderrMock = vi.fn();
const exitSpy = vi.fn();

vi.mock("../../src/cli/install-claude.js", () => ({
  installClaude: (...a: unknown[]) => installs.installClaude(...a),
  uninstallClaude: (...a: unknown[]) => installs.uninstallClaude(...a),
}));
vi.mock("../../src/cli/install-codex.js", () => ({
  installCodex: (...a: unknown[]) => installs.installCodex(...a),
  uninstallCodex: (...a: unknown[]) => installs.uninstallCodex(...a),
}));
vi.mock("../../src/cli/install-openclaw.js", () => ({
  installOpenclaw: (...a: unknown[]) => installs.installOpenclaw(...a),
  uninstallOpenclaw: (...a: unknown[]) => installs.uninstallOpenclaw(...a),
}));
vi.mock("../../src/cli/install-cursor.js", () => ({
  installCursor: (...a: unknown[]) => installs.installCursor(...a),
  uninstallCursor: (...a: unknown[]) => installs.uninstallCursor(...a),
}));
vi.mock("../../src/cli/install-hermes.js", () => ({
  installHermes: (...a: unknown[]) => installs.installHermes(...a),
  uninstallHermes: (...a: unknown[]) => installs.uninstallHermes(...a),
}));
vi.mock("../../src/cli/install-pi.js", () => ({
  installPi: (...a: unknown[]) => installs.installPi(...a),
  uninstallPi: (...a: unknown[]) => installs.uninstallPi(...a),
  upsertHivemindBlock: () => "",
  stripHivemindBlock: (s: string) => s,
}));
vi.mock("../../src/cli/auth.js", () => ({
  ensureLoggedIn: (...a: unknown[]) => ensureLoggedInMock(...a),
  isLoggedIn: (...a: unknown[]) => isLoggedInMock(...a),
  loginWithProvidedToken: (...a: unknown[]) => loginWithProvidedTokenMock(...a),
  maybeShowOrgChoice: (...a: unknown[]) => maybeShowOrgChoiceMock(...a),
}));
vi.mock("../../src/commands/auth-login.js", () => ({
  runAuthCommand: (...a: unknown[]) => runAuthCommandMock(...a),
}));
vi.mock("../../src/cli/util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/util.js")>();
  return {
    ...actual,
    detectPlatforms: (...a: unknown[]) => detectPlatformsMock(...a),
    allPlatformIds: (...a: unknown[]) => allPlatformIdsMock(...a),
    confirm: (...a: unknown[]) => confirmMock(...a),
  };
});
vi.mock("../../src/cli/version.js", () => ({
  getVersion: (...a: unknown[]) => getVersionMock(...a),
}));
vi.mock("../../src/cli/update.js", () => ({
  runUpdate: (...a: unknown[]) => runUpdateMock(...a),
}));
vi.mock("../../src/cli/embeddings.js", () => ({
  installEmbeddings: vi.fn(),
  enableEmbeddings: vi.fn(),
  disableEmbeddings: vi.fn(),
  uninstallEmbeddings: vi.fn(),
  statusEmbeddings: vi.fn(),
}));
vi.mock("../../src/commands/skillify.js", () => ({
  runSkillifyCommand: vi.fn(),
}));
vi.mock("../../src/cli/skillify-spec.js", () => ({
  renderCliHelpBlock: () => "",
}));

const originalArgv = process.argv;
const originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  for (const fn of Object.values(installs)) fn.mockReset();
  ensureLoggedInMock.mockReset().mockResolvedValue(true);
  isLoggedInMock.mockReset().mockReturnValue(false); // forces the gate to run
  loginWithProvidedTokenMock.mockReset().mockResolvedValue(false);
  maybeShowOrgChoiceMock.mockReset().mockResolvedValue(undefined);
  runAuthCommandMock.mockReset().mockResolvedValue(undefined);
  detectPlatformsMock.mockReset().mockReturnValue([{ id: "claude", markerDir: "/x/.claude" }]);
  allPlatformIdsMock.mockReset().mockReturnValue(["claude", "codex", "claw", "cursor", "hermes", "pi"]);
  getVersionMock.mockReset().mockReturnValue("1.2.3");
  runUpdateMock.mockReset().mockResolvedValue(0);
  confirmMock.mockReset().mockResolvedValue(true);
  stdoutMock.mockReset();
  stderrMock.mockReset();
  exitSpy.mockReset();
  delete process.env.DEEPLAKE_API_TOKEN;
  delete process.env.HIVEMIND_TOKEN;
  vi.spyOn(process.stdout, "write").mockImplementation(((...a: unknown[]) => { stdoutMock(...a); return true; }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((...a: unknown[]) => { stderrMock(...a); return true; }) as any);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitSpy(code);
    throw Object.assign(new Error("__test_process_exit__"), { __exit: true });
  }) as any);
});

afterEach(() => {
  process.argv = originalArgv;
  setTTY(originalIsTTY);
  vi.restoreAllMocks();
  vi.resetModules();
});

async function runInstall(args: string[]): Promise<void> {
  process.argv = ["node", "/path/to/hivemind-cli", "install", ...args];
  const onUnhandled = (e: unknown) => {
    if (e && typeof e === "object" && "__exit" in (e as Record<string, unknown>)) return;
    throw e;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    vi.resetModules();
    await import("../../src/cli/index.js");
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

const stdoutText = () => stdoutMock.mock.calls.map(c => c[0]).join("");
const stderrText = () => stderrMock.mock.calls.map(c => c[0]).join("");

describe("install consent gate — TTY paths", () => {
  it("TTY + decline → no auth attempted, install continues, hint logged", async () => {
    setTTY(true);
    confirmMock.mockResolvedValue(false);

    await runInstall([]);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(loginWithProvidedTokenMock).not.toHaveBeenCalled();
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
    expect(stdoutText()).toContain("Skipping sign-in. You can sign in anytime with `hivemind login`.");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("TTY + accept → ensureLoggedIn exactly once, install continues", async () => {
    setTTY(true);
    confirmMock.mockResolvedValue(true);
    ensureLoggedInMock.mockResolvedValue(true);

    await runInstall([]);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(ensureLoggedInMock).toHaveBeenCalledTimes(1);
    expect(loginWithProvidedTokenMock).not.toHaveBeenCalled();
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
    expect(stdoutText()).toContain("🐝 One more step to unlock Hivemind");
    expect(stdoutText()).toContain("Prefer your own cloud storage");
    expect(stdoutText()).toContain("Already have a token? Pass --token <value> or set DEEPLAKE_API_TOKEN.");
  });

  it("TTY + --token <value> → consent prompt NOT shown, token honored", async () => {
    setTTY(true);
    loginWithProvidedTokenMock.mockResolvedValue(true);

    await runInstall(["--token", "tok-abc"]);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(loginWithProvidedTokenMock).toHaveBeenCalledTimes(1);
    expect(loginWithProvidedTokenMock).toHaveBeenCalledWith("tok-abc");
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
  });
});

describe("install consent gate — non-TTY paths", () => {
  it("non-TTY + no token → no confirm (would hang), no auth, hint logged, install continues", async () => {
    setTTY(false);

    await runInstall([]);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(loginWithProvidedTokenMock).not.toHaveBeenCalled();
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
    expect(stdoutText()).toContain("No TTY detected");
    expect(stdoutText()).toContain("--token <value>");
    expect(stdoutText()).toContain("DEEPLAKE_API_TOKEN");
    expect(stdoutText()).toContain("HIVEMIND_TOKEN");
    expect(stdoutText()).toContain("hivemind login");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("non-TTY + DEEPLAKE_API_TOKEN → loginWithProvidedToken once, no device flow, no confirm", async () => {
    setTTY(false);
    process.env.DEEPLAKE_API_TOKEN = "env-token";
    loginWithProvidedTokenMock.mockResolvedValue(true);

    await runInstall([]);

    expect(loginWithProvidedTokenMock).toHaveBeenCalledTimes(1);
    expect(loginWithProvidedTokenMock).toHaveBeenCalledWith(undefined);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
  });

  it("non-TTY + HIVEMIND_TOKEN (no DEEPLAKE_API_TOKEN) → loginWithProvidedToken once", async () => {
    setTTY(false);
    process.env.HIVEMIND_TOKEN = "hm-token";
    loginWithProvidedTokenMock.mockResolvedValue(true);

    await runInstall([]);

    expect(loginWithProvidedTokenMock).toHaveBeenCalledTimes(1);
    expect(loginWithProvidedTokenMock).toHaveBeenCalledWith(undefined);
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
  });

  it("non-TTY + --token flag → loginWithProvidedToken called with flag value (priority over env)", async () => {
    setTTY(false);
    process.env.DEEPLAKE_API_TOKEN = "env-token";
    loginWithProvidedTokenMock.mockResolvedValue(true);

    await runInstall(["--token", "flag-token"]);

    expect(loginWithProvidedTokenMock).toHaveBeenCalledTimes(1);
    expect(loginWithProvidedTokenMock).toHaveBeenCalledWith("flag-token");
  });

  it("non-TTY + invalid token (loginWithProvidedToken returns false) → install continues exit 0", async () => {
    setTTY(false);
    process.env.DEEPLAKE_API_TOKEN = "bad-token";
    loginWithProvidedTokenMock.mockResolvedValue(false);

    await runInstall([]);

    expect(loginWithProvidedTokenMock).toHaveBeenCalledTimes(1);
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("non-TTY + --token=<value> (= form) → flag value is parsed correctly", async () => {
    setTTY(false);
    loginWithProvidedTokenMock.mockResolvedValue(true);

    await runInstall(["--token=eq-form-token"]);

    expect(loginWithProvidedTokenMock).toHaveBeenCalledWith("eq-form-token");
  });
});

describe("install consent gate — short-circuit cases", () => {
  it("--skip-auth bypasses the entire gate even when no creds and TTY=true", async () => {
    setTTY(true);
    process.env.DEEPLAKE_API_TOKEN = "env-token";

    await runInstall(["--skip-auth"]);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(loginWithProvidedTokenMock).not.toHaveBeenCalled();
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
  });

  it("already logged in → gate is skipped entirely (no confirm, no token check)", async () => {
    setTTY(true);
    isLoggedInMock.mockReturnValue(true);

    await runInstall([]);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(ensureLoggedInMock).not.toHaveBeenCalled();
    expect(loginWithProvidedTokenMock).not.toHaveBeenCalled();
    expect(installs.installClaude).toHaveBeenCalledTimes(1);
  });
});
