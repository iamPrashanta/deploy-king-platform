import fs from "node:fs";
import { safeEqual } from "../config";

/**
 * The deploy key of Deploy King Desktop (DESKTOP_APP_PLAN.md, Phase 4).
 *
 * On a desktop machine the app makes 32 random bytes, keeps them in the computer's protected storage,
 * and writes them inside the machine to a root-only file. It then calls the API with
 * `Authorization: Desktop <key>`. The key is only accepted when the API runs with DESKTOP_MODE=true,
 * and it is read from the file on every call, so rotating it needs no restart. No file, an empty file,
 * or a short key: nothing is accepted.
 */
export const DEFAULT_DESKTOP_KEY_FILE = "/etc/deploy-king/desktop.key";

export const desktopModeOn = (env: NodeJS.ProcessEnv = process.env) => env.DESKTOP_MODE === "true";

export function readDesktopKey(file = process.env.DESKTOP_KEY_FILE || DEFAULT_DESKTOP_KEY_FILE): string | null {
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

/** Does this Authorization header carry the expected key? Constant-time; never throws. */
export function desktopKeyMatches(header: unknown, expected: string | null): boolean {
  if (!expected || typeof header !== "string" || !header.startsWith("Desktop ")) return false;
  const given = header.slice("Desktop ".length).trim();
  if (given.length < 32 || given.length > 256) return false;
  return safeEqual(given, expected);
}
