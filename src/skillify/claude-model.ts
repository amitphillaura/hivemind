/**
 * Shared `claude -p` backend for the engine's LLM steps (success-judge, proposer).
 * All tools denied → pure-text generation. Runs on the USER's own agent, so cost
 * lands on the user. Returned as an injectable ModelCall so every LLM step is
 * unit-testable with zero real calls.
 */
import { spawn } from "node:child_process";

/** (systemPrompt, userPrompt) -> raw model text. */
export type ModelCall = (systemPrompt: string, userPrompt: string) => Promise<string>;

const DENY = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"];

export function claudeModel(model: string, opts: { timeoutMs?: number } = {}): ModelCall {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return (system, user) => new Promise<string>((resolve, reject) => {
    const args = [
      "-p", user, "--model", model, "--no-session-persistence",
      "--output-format", "json", "--system-prompt", system, "--disallowed-tools", ...DENY,
    ];
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claude timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 200)}`));
      try { resolve(String((JSON.parse(out) as { result?: unknown }).result ?? "")); }
      catch { resolve(out); }
    });
  });
}
