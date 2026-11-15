import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, sessions, users } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { JWT_SECRET } from "../config";

export type AuthedUser = { sub: string; sid: string; username: string; role: string };

/**
 * Verifies a bearer token the same way the tRPC middleware does: the JWT must be
 * valid AND its server-side session row must still exist and be unexpired.
 * Returns null instead of throwing so callers (REST, WebSocket) decide the response.
 */
export async function verifyToken(token: string | undefined | null): Promise<AuthedUser | null> {
  if (!token) return null;
  let payload: any;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (!payload?.sub || !payload?.sid) return null;

  const [row] = await db
    .select({ expiresAt: sessions.expiresAt, role: users.role, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, payload.sid))
    .limit(1);

  if (!row || row.expiresAt < new Date()) return null;
  // Role comes from the database, not the token, so a demotion applies immediately.
  return { sub: payload.sub, sid: payload.sid, username: row.username, role: row.role };
}

/** Express guard for the legacy REST routes. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const user = await verifyToken(token);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as any).user = user;
    next();
  } catch (err) {
    console.error("[Auth] requireAuth failed:", err);
    res.status(500).json({ error: "Authentication service unavailable" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
