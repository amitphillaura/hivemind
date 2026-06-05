/**
 * Graph-build ignore configuration.
 *
 * Two layers keep dependency / build-output directories out of the code graph
 * (so a Python `venv/`, a JS `node_modules/`, etc. never pollute it):
 *
 *   1. A user-editable JSON at ~/.deeplake/graph-ignore.json listing directory
 *      NAMES to skip. Seeded with a broad default set on first build; the user
 *      (or their AI assistant) can edit it freely.
 *   2. The repo's own .gitignore, respected at discovery time via
 *      `git ls-files --exclude-standard` (see src/commands/graph.ts) — git's own
 *      ignore engine, so anchoring / nested rules / subtrees are handled
 *      correctly rather than by a naive basename parse.
 *
 * The name list is matched by directory BASENAME, so it is intentionally
 * conservative about source-like names (e.g. `packages`, `bin`, `lib`, `src`
 * are NOT in the defaults — monorepos keep real source there). Output dirs that
 * are source in rare setups (`build`, `dist`, `out`, `target`) are included by
 * convention but can be removed from the JSON per project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Broad default set of directory names never (or almost never) holding first-party source. */
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  // JS / TS toolchains
  "node_modules", "bower_components", "jspm_packages", ".pnpm-store",
  "dist", "build", "out", "coverage", "bundle",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", ".vite", ".nyc_output",
  // Python
  "venv", ".venv", "env", ".env", "virtualenv", "__pycache__", "site-packages", "__pypackages__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".eggs", ".ipynb_checkpoints", ".hypothesis",
  // Rust / Java / .NET / Go vendoring
  "target", "obj", "vendor", ".gradle", ".mvn",
  // Native / mobile
  "Pods", "DerivedData", ".build",
  // VCS / IDE
  ".git", ".svn", ".hg", ".idea", ".vscode", ".vs",
  // Infra / misc
  ".terraform", "tmp", "temp", "logs", "third_party", "third-party",
];

export interface GraphIgnoreConfig {
  /** Directory names skipped during discovery (matched by basename). */
  ignoreDirs: string[];
  /** When true, the repo's .gitignore is also respected (via git ls-files). */
  respectGitignore: boolean;
}

const FILE_NAME = "graph-ignore.json";

function defaultConfigObject(): Record<string, unknown> {
  return {
    _comment:
      "Directory names skipped when building the hivemind code graph. Edit freely. " +
      "When respectGitignore is true, the repo's .gitignore is also honored (anchoring-correct).",
    ignoreDirs: [...DEFAULT_IGNORE_DIRS],
    respectGitignore: true,
  };
}

/**
 * Load ~/.deeplake/graph-ignore.json. Seeds it with the defaults on first call
 * (so there's a file to edit). Best-effort: any IO/parse error falls back to the
 * built-in defaults without throwing. `deeplakeDir` is injectable for tests.
 */
export function loadGraphIgnore(deeplakeDir: string = join(homedir(), ".deeplake")): GraphIgnoreConfig {
  const path = join(deeplakeDir, FILE_NAME);
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GraphIgnoreConfig>;
      const ignoreDirs = Array.isArray(parsed.ignoreDirs)
        ? parsed.ignoreDirs.filter((s): s is string => typeof s === "string")
        : [...DEFAULT_IGNORE_DIRS];
      const respectGitignore = typeof parsed.respectGitignore === "boolean" ? parsed.respectGitignore : true;
      return { ignoreDirs, respectGitignore };
    }
    // First run — seed the defaults for the user to edit.
    mkdirSync(deeplakeDir, { recursive: true });
    writeFileSync(path, JSON.stringify(defaultConfigObject(), null, 2) + "\n");
  } catch {
    // best-effort — fall through to in-memory defaults
  }
  return { ignoreDirs: [...DEFAULT_IGNORE_DIRS], respectGitignore: true };
}

/** Build the basename ignore Set from a config. */
export function ignoreDirSet(config: GraphIgnoreConfig): Set<string> {
  return new Set(config.ignoreDirs);
}

/**
 * True when a repo-relative path has any IGNORED directory segment, or any
 * dot-directory segment (mirrors the manual walk's dotdir skip). The final
 * path component (the file) is exempt from the dotdir rule so a leading-dot
 * filename isn't spuriously dropped.
 */
export function pathHasIgnoredSegment(relPath: string, ignore: Set<string>): boolean {
  const segs = relPath.split("/");
  return segs.some(
    (seg, i) => ignore.has(seg) || (i < segs.length - 1 && seg.startsWith(".")),
  );
}
