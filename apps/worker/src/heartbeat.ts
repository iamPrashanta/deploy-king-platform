import fs from "node:fs";
import IORedis from "ioredis";
import { db } from "@dbbkp/db";
import { sql } from "drizzle-orm";
import { connection } from "./connection";

/**
 * The worker has no HTTP port, so its container health check reads a file instead:
 * every 20 seconds, when Redis and the database both answer, the file's time is updated.
 * HEARTBEAT_FILE="" turns it off.
 */
const FILE = process.env.HEARTBEAT_FILE ?? "/tmp/dk-worker-alive";

if (FILE) {
  const redis = new IORedis({ ...connection, maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on("error", () => {});
  const beat = async () => {
    try {
      await redis.ping();
      await db.execute(sql`select 1`);
      fs.writeFileSync(FILE, String(Date.now()));
    } catch {
      // stale file = unhealthy
    }
  };
  void beat();
  setInterval(beat, 20_000).unref();
}
