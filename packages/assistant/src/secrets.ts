import crypto from "node:crypto";

/**
 * Keeps secret values away from the model.
 *
 * - Values the user types (`JWT_SECRET=…`, a pasted token) are swapped for a reference `{{secret:NAME}}`
 *   before the message goes to the model. The model uses the reference in tool input; it is swapped back
 *   only when the tool runs.
 * - `{{random}}` / `{{random:48}}` in tool input becomes a fresh random value made here, never by the model.
 * - Everything that goes back to the model (tool results, logs) passes through hide(): known values become
 *   their reference again, and anything that looks like a credential is masked (the hideSecrets idea of
 *   apps/worker/src/cron.worker.ts, plus patterns for values we were never told about).
 */

export const MASK = "••••••";

/** Variable names whose values are secret. */
export const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PWD|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH(?!OR)|SALT|SIGNING|(?:^|_)KEY(?:$|_)|DSN|DATABASE_URL|REDIS_URL|MONGO(DB)?_UR[IL]|AMQP_URL|CONNECTION_STRING|WEBHOOK_URL|COOKIE)/i;

/** Shapes of well-known credentials, masked wherever they show up. */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bdk_[A-Za-z0-9_-]{30,60}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

/** user:password@ in URLs: the password goes. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
/** NAME=value, NAME: value, "NAME": "value" with a secret-looking name. */
const ASSIGNMENT = /(\b[A-Za-z_][A-Za-z0-9_]*\b)("?\s*[:=]\s*"?)([^\s"',;\u0000]{3,})/g;

const REF = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g;
const RANDOM = /\{\{\s*random(?::(\d{1,3}))?\s*\}\}/g;

export class SecretStore {
  private byName = new Map<string, string>();
  private n = 0;

  /** Remember a value; returns the reference the model sees. */
  add(name: string, value: string): string {
    const clean = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 60) || "SECRET";
    let key = clean;
    for (const [k, v] of this.byName) if (v === value) return `{{secret:${k}}}`;
    for (let i = 2; this.byName.has(key) && this.byName.get(key) !== value; i++) key = `${clean}_${i}`;
    this.byName.set(key, value);
    return `{{secret:${key}}}`;
  }

  get size() {
    return this.byName.size;
  }

  has(name: string) {
    return this.byName.has(name);
  }

  names() {
    return [...this.byName.keys()];
  }

  /**
   * For text the user typed: secret values become references. The model still knows a secret was given
   * (and its name), never its value.
   */
  captureFromUserText(text: string): string {
    const named = (m: string, name: string, sep: string, value: string) => (!SECRET_NAME.test(name) || value.includes("{{") || isHarmless(value) ? m : name + sep + this.add(name, value));
    // Named values first, so a whole DATABASE_URL is kept under its own name.
    let out = text.replace(ASSIGNMENT, named);
    // "set JWT_SECRET to abc123"
    out = out.replace(/(\b[A-Z][A-Z0-9_]*\b)(\s+(?:to|as)\s+)([^\s"',;]{3,})/g, named);
    for (const re of PATTERNS) out = out.replace(re, (m) => this.add(`PASTED_${++this.n}`, m));
    out = out.replace(URL_PASSWORD, (m, a: string, pw: string, b: string) => (pw.includes("{{") ? m : a + this.add(`URL_PASSWORD_${++this.n}`, pw) + b));
    return out;
  }

  /** For anything going to the model or shown as tool input: known values back to references, credentials masked. */
  hide(text: string): string {
    if (!text) return text;
    let out = text;
    // Longest first, so a value that contains another is replaced whole.
    const known = [...this.byName.entries()].filter(([, v]) => v.length >= 4).sort((a, b) => b[1].length - a[1].length);
    for (const [k, v] of known) {
      out = out.split(v).join(`{{secret:${k}}}`);
      const enc = encodeURIComponent(v);
      if (enc !== v) out = out.split(enc).join(`{{secret:${k}}}`);
    }
    // References are kept as they are: park them while the patterns run.
    const refs: string[] = [];
    out = out.replace(REF, (m) => `\u0000${refs.push(m) - 1}\u0000`);
    for (const re of PATTERNS) out = out.replace(re, MASK);
    out = out.replace(URL_PASSWORD, (m, a: string, pw: string, b: string) => (pw.startsWith("{{secret:") || pw === MASK ? m : a + MASK + b));
    out = out.replace(ASSIGNMENT, (m, name: string, sep: string, value: string) => (SECRET_NAME.test(name) && !value.startsWith("{{") && value !== MASK && !isHarmless(value) ? name + sep + MASK : m));
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => refs[Number(i)]!);
  }

  /** hide() over any JSON value: every string in it, and the whole value of a secret-looking key. */
  hideValue<T>(v: T): T {
    const walk = (x: unknown, key?: string): unknown => {
      if (typeof x === "string") {
        if (key && secretKey(key) && !x.includes("{{") && !isHarmless(x) && x.length >= 3) {
          const hidden = this.hide(x);
          return hidden.includes("{{secret:") ? hidden : MASK;
        }
        return this.hide(x);
      }
      if (Array.isArray(x)) return x.map((y) => walk(y));
      if (x && typeof x === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, y] of Object.entries(x)) out[k] = walk(y, k);
        return out;
      }
      return x;
    };
    return walk(v) as T;
  }

  /**
   * Swaps references and {{random}} back to real values, just before a tool runs.
   * `nameHint` names a random value after the variable it is for (JWT_SECRET), so later output shows that name.
   */
  resolve(value: unknown, nameHint?: string): unknown {
    if (typeof value === "string") {
      let s = value.replace(RANDOM, (_m, len?: string) => {
        const n = Math.min(Math.max(Number(len ?? 32) || 32, 8), 256);
        const v = crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
        this.add(nameHint ?? `RANDOM_${++this.n}`, v);
        return v;
      });
      s = s.replace(REF, (_m, name: string) => {
        const v = this.byName.get(name);
        if (v === undefined) throw new UnknownSecretError(name);
        return v;
      });
      return s;
    }
    if (Array.isArray(value)) return value.map((x) => this.resolve(x, nameHint));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.resolve(v, /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k === k.toUpperCase() ? k : nameHint);
      return out;
    }
    return value;
  }
}

/** A JSON field whose whole value is secret: an env-style name (JWT_SECRET) or a well-known credential field. */
function secretKey(key: string) {
  return (/^[A-Z][A-Z0-9_]*$/.test(key) && SECRET_NAME.test(key)) || /^(password|passwd|secret|token|api_?key|access_?token|refresh_?token|private_?key|client_?secret|credentials?)$/i.test(key);
}

/** Values that are clearly not secrets even under a secret-looking name (flags, empty placeholders). */
function isHarmless(value: string) {
  return /^(true|false|null|none|undefined|yes|no|on|off|\d{1,6}|changeme|change_me|xxx+|\*+|<[^>]*>|\$\{[^}]*\})$/i.test(value);
}

export class UnknownSecretError extends Error {
  constructor(public secretName: string) {
    super(`There is no secret called ${secretName}. Ask the user for it, or use {{random}} for a new random value.`);
  }
}
