import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ~/.config/deploy-king/config.json, readable by its owner only (0600, folder 0700): it holds the Deploy King
 * API token and, when set, the Anthropic API key.
 */
export interface DkConfig {
  apiUrl?: string;
  token?: string;
  anthropicKey?: string;
  model?: string;
  /** Apps whose plans run without asking ("Yes, and don't ask again"), per Deploy King API URL. */
  trustedApps?: Record<string, string[]>;
}

export const DEFAULT_API_URL = "http://localhost:4000";

export function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "deploy-king");
}

export function configPath() {
  return process.env.DK_CONFIG || path.join(configDir(), "config.json");
}

export function readConfig(): DkConfig {
  try {
    const text = fs.readFileSync(configPath(), "utf8");
    const c = JSON.parse(text);
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

export function writeConfig(c: DkConfig) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write to a private temp file, then move it in place, so the secret is never readable by others, not even briefly.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function updateConfig(patch: (c: DkConfig) => void) {
  const c = readConfig();
  patch(c);
  writeConfig(c);
  return c;
}

/** What dk runs with: the environment wins over the file (DK_API_URL, DK_TOKEN, ANTHROPIC_API_KEY, DK_MODEL). */
export function effective() {
  const c = readConfig();
  return {
    apiUrl: (process.env.DK_API_URL || c.apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
    token: process.env.DK_TOKEN || c.token || "",
    anthropicKey: process.env.ANTHROPIC_API_KEY || c.anthropicKey || "",
    anthropicKeyFrom: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : c.anthropicKey ? "config" : "",
    model: process.env.DK_MODEL || c.model || "",
    trusted: new Set((c.trustedApps ?? {})[(process.env.DK_API_URL || c.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "")] ?? []),
  };
}

export function trustApp(apiUrl: string, app: string) {
  updateConfig((c) => {
    const all = (c.trustedApps ??= {});
    const list = new Set(all[apiUrl] ?? []);
    list.add(app);
    all[apiUrl] = [...list].sort();
  });
}

/** dk_abc… → dk_abc•••• (for dk config show). */
export const masked = (s: string | undefined) => (s ? `${s.slice(0, 6)}••••${s.length > 14 ? s.slice(-2) : ""}` : "(not set)");
