import "./env";
import crypto from "node:crypto";

/**
 * Single source of truth for platform secrets and connections.
 *
 * Previously every file carried its own `process.env.X || "some-default"`, and the
 * defaults did not agree with each other (tRPC verified JWTs with a different
 * fallback than the one login signed them with). Everything now imports from here.
 */

const isProd = process.env.NODE_ENV === "production";

const KNOWN_INSECURE_DEFAULTS = new Set([
  "dev-secret",
  "dbbkp-super-secret-change-in-prod",
  "dbbkp-internal-secret-change-me",
]);

function secret(name: string, devFallback: string): string {
  const value = process.env[name];
  if (isProd) {
    if (!value || KNOWN_INSECURE_DEFAULTS.has(value)) {
      throw new Error(`[Config] ${name} must be set to a unique secret in production.`);
    }
    return value;
  }
  if (!value) {
    console.warn(`[Config] ${name} is not set - using an insecure development default.`);
    return devFallback;
  }
  return value;
}

export const JWT_SECRET = secret("JWT_SECRET", "dbbkp-super-secret-change-in-prod");
export const INTERNAL_SECRET = secret("INTERNAL_SECRET", "dbbkp-internal-secret-change-me");

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** BullMQ/ioredis connection options. REDIS_URL wins, then REDIS_HOST/PORT/PASSWORD. */
export function redisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname,
        port: Number.parseInt(u.port || "6379", 10),
        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        ...(u.protocol === "rediss:" ? { tls: {} } : {}),
      };
    } catch {
      console.warn("[Config] REDIS_URL is not a valid URL - falling back to REDIS_HOST/REDIS_PORT.");
    }
  }
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  };
}

/** Root directory that holds every site's source tree. */
export const SITES_ROOT = (process.env.SITES_ROOT || "/var/www/sites").replace(/\/+$/, "");

/** Docker network shared by Traefik and every site container. */
export const NETWORK = process.env.DBBKP_NETWORK || "dbbkp";
/** Apps get <name>.<BASE_DOMAIN> by default. "localhost" works in browsers with no DNS setup. */
export const BASE_DOMAIN = (process.env.DBBKP_BASE_DOMAIN || "localhost").replace(/^\.+|\.+$/g, "");
/** Port Traefik's web entrypoint is reachable on from the browser (for building links). */
export const PUBLIC_HTTP_PORT = Number(process.env.DBBKP_PUBLIC_HTTP_PORT || 80);
export const TLS_ENABLED = (process.env.DBBKP_TLS ?? "true") !== "false";
/** Public URL of this API, used to show webhook URLs. */
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || "").replace(/\/+$/, "");

/** The address people open an app at, e.g. https://my-app.example.com or http://my-app.localhost:8088. */
export function publicAppUrl(domain: string) {
  const proto = TLS_ENABLED ? "https" : "http";
  const port = TLS_ENABLED ? 443 : PUBLIC_HTTP_PORT;
  const plain = (proto === "https" && port === 443) || (proto === "http" && port === 80);
  return `${proto}://${domain}${plain ? "" : `:${port}`}`;
}
