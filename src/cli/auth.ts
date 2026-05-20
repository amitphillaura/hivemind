import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, log, warn } from "./util.js";
import { login, loadCredentials, listOrgs, saveCredentialsFromToken } from "../commands/auth.js";

const DEFAULT_API_URL = "https://api.deeplake.ai";

function resolveApiUrl(): string {
  return process.env.HIVEMIND_API_URL ?? process.env.DEEPLAKE_API_URL ?? DEFAULT_API_URL;
}

const CREDS_PATH = join(HOME, ".deeplake", "credentials.json");

export function isLoggedIn(): boolean {
  return existsSync(CREDS_PATH) && loadCredentials() !== null;
}

export async function ensureLoggedIn(): Promise<boolean> {
  if (isLoggedIn()) return true;

  log("");
  log("No Deeplake credentials found. Starting login...");

  try {
    await login(resolveApiUrl());
  } catch (err) {
    warn(`Login failed: ${(err as Error).message}`);
    return false;
  }

  return isLoggedIn();
}

// Sign in using a long-lived API token from --token, DEEPLAKE_API_TOKEN, or
// HIVEMIND_TOKEN. Returns false when no token is present so callers can
// distinguish "no token attempted" from "token attempted and failed". A
// failed token validation is warned-and-continued, never thrown — install
// must not break on auth.
export async function loginWithProvidedToken(flagToken?: string): Promise<boolean> {
  const token = flagToken
    ?? process.env.DEEPLAKE_API_TOKEN
    ?? process.env.HIVEMIND_TOKEN;
  if (!token) return false;

  try {
    await saveCredentialsFromToken(token, resolveApiUrl(), { skipTokenMint: true });
    const source = flagToken
      ? "--token flag"
      : process.env.DEEPLAKE_API_TOKEN
        ? "DEEPLAKE_API_TOKEN"
        : "HIVEMIND_TOKEN";
    log(`Signed in via ${source}.`);
    return true;
  } catch (err) {
    warn(`Token authentication failed: ${(err as Error).message}. Continuing install.`);
    return false;
  }
}

export async function maybeShowOrgChoice(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) return;
  try {
    const orgs = await listOrgs(creds.token, creds.apiUrl ?? "https://api.deeplake.ai");
    if (orgs.length <= 1) return;
    const activeName = creds.orgName ?? creds.orgId;
    log("");
    log(`You belong to ${orgs.length} orgs. Active: ${activeName}`);
    log(`  Change with: hivemind org switch <name-or-id>`);
  } catch {
    // Best-effort; don't fail install on a transient network issue.
  }
}
