import "./env";

/** BullMQ/ioredis connection options. REDIS_URL wins, then REDIS_HOST/PORT/PASSWORD. */
function redisConnection() {
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
      console.warn("[Worker] REDIS_URL is not a valid URL - falling back to REDIS_HOST/REDIS_PORT.");
    }
  }
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  };
}

export const connection = redisConnection();
