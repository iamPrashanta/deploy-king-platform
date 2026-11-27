import { Worker } from "bullmq";
import { connection } from "./connection";
import { db, dbInstances } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { ident, literal, localConn, psql } from "@dbbkp/backup";

export const databaseWorker = new Worker(
  "database",
  async (job) => {
    if (job.name !== "create-postgres") return;

    const { instanceId, dbName, dbUser, dbPass } = job.data;
    const [instance] = await db.select().from(dbInstances).where(eq(dbInstances.id, instanceId)).limit(1);
    
    if (!instance) throw new Error(`DB Instance ${instanceId} not found in database`);

    console.log(`[DatabaseWorker] Provisioning PostgreSQL database: ${dbName} for user: ${dbUser}`);

    try {
      // On the server's own PostgreSQL: DK_PG_ADMIN_URL when set, the postgres user through sudo otherwise (@dbbkp/backup).
      const admin = localConn("postgres");
      await psql(admin, `CREATE DATABASE ${ident(dbName)}`);
      console.log(`[DatabaseWorker] Created database: ${dbName}`);

      await psql(admin, `CREATE USER ${ident(dbUser)} WITH ENCRYPTED PASSWORD ${literal(dbPass)}`);
      console.log(`[DatabaseWorker] Created user: ${dbUser}`);

      await psql(admin, `GRANT ALL PRIVILEGES ON DATABASE ${ident(dbName)} TO ${ident(dbUser)}`);
      await psql(localConn(dbName), `ALTER SCHEMA public OWNER TO ${ident(dbUser)}`);
      console.log(`[DatabaseWorker] Granted privileges for ${dbName} to ${dbUser}`);

      return { success: true, message: `Database ${dbName} provisioned` };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      
      // If error contains "already exists", it might be a partial failure or re-run, we can just log it
      if (message.includes("already exists")) {
        console.warn(`[DatabaseWorker] Resource already exists during DB creation: ${message}`);
        return { success: true, message: `Recovered: Resource already exists` };
      }

      console.error(`[DatabaseWorker] DB Provisioning failed:`, message);
      throw err;
    }
  },
  { connection, concurrency: 2 }
);

console.log("[Worker Node] Booted database worker");
