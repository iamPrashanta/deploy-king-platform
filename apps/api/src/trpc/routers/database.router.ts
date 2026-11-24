import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, permissionProcedure } from "../trpc";
import { db, dbInstances, sites } from "@dbbkp/db";
import { eq, inArray, sql } from "drizzle-orm";
import { PERMISSIONS } from "../../utils/rbac";
import { requireSite, visibleSites } from "../../services/team";
import { databaseQueue } from "../../queues";
import crypto from "node:crypto";

export const databaseRouter = router({
  // Admins see every database; everyone else only those attached to an app they may see.
  list: protectedProcedure.query(async ({ ctx }) => {
    const limit = await visibleSites(ctx.user!);
    if (!limit) return db.select().from(dbInstances).orderBy(sql`created_at DESC`);
    const ids = (await db.select({ id: sites.id }).from(sites).where(limit)).map((s) => s.id);
    if (!ids.length) return [];
    return db.select().from(dbInstances).where(inArray(dbInstances.siteId, ids)).orderBy(sql`created_at DESC`);
  }),

  create: permissionProcedure(PERMISSIONS.DATABASE_CREATE)
    .input(
      z.object({
        name: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/),
        type: z.enum(["pgsql", "mysql"]).default("pgsql"),
        dbUser: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/),
        siteId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // A database for an app needs that app; one that belongs to no app is the admin's to create.
      if (input.siteId) await requireSite(ctx.user!, input.siteId);
      else if (ctx.user!.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Choose the app this database is for." });
      const dbPass = crypto.randomBytes(12).toString("hex");

      // Check if name already taken
      const existing = await db.select().from(dbInstances).where(eq(dbInstances.name, input.name)).limit(1);
      if (existing.length > 0) {
        throw new Error("Database name already in use.");
      }

      const [newInstance] = await db.insert(dbInstances).values({
        id: crypto.randomUUID(),
        name: input.name,
        type: input.type,
        dbUser: input.dbUser,
        siteId: input.siteId,
      }).returning();

      if (input.type === "pgsql") {
        await databaseQueue.add("create-postgres", {
          instanceId: newInstance.id,
          dbName: input.name,
          dbUser: input.dbUser,
          dbPass: dbPass,
        });
      } else {
        // Future: implement mysql logic or throw
        throw new Error("MySQL provisioning is not yet implemented.");
      }

      return {
        instance: newInstance,
        credentials: {
          username: input.dbUser,
          password: dbPass,
          host: "127.0.0.1",
          port: input.type === "pgsql" ? 5432 : 3306,
          database: input.name,
        }
      };
    }),

  delete: permissionProcedure(PERMISSIONS.DATABASE_CREATE)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const [row] = await db.select().from(dbInstances).where(eq(dbInstances.id, input.id)).limit(1);
      const notFound = new TRPCError({ code: "NOT_FOUND", message: "Database not found" });
      if (!row) throw notFound;
      if (ctx.user!.role !== "admin") {
        if (!row.siteId) throw notFound;
        await requireSite(ctx.user!, row.siteId).catch(() => { throw notFound; });
      }
      // NOTE: For safety in this early version, we only delete the DB record.
      // We don't automatically drop production databases from PostgreSQL to prevent data loss.
      // The user must drop them manually or we can add a specific `forceDrop` flag later.
      await db.delete(dbInstances).where(eq(dbInstances.id, input.id));
      return { success: true, message: "Database record deleted. Physical DB preserved for safety." };
    }),
});
