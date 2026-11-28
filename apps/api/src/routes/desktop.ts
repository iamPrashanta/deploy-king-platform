import type { Express, NextFunction, Request, Response } from "express";
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, apiTokens, users } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import { issueSession } from "../services/team";
import { newToken } from "../services/apiTokens";
import { desktopKeyMatches, desktopModeOn, readDesktopKey } from "../services/desktopKey";

/**
 * Deploy King Desktop's way in (DESKTOP_APP_PLAN.md, Phase 4). Only when DESKTOP_MODE=true.
 *
 *   POST /api/desktop/session      Authorization: Desktop <key>  → { token } a normal session for the local admin
 *   POST /api/desktop/agent-token  Authorization: Desktop <key>  → { token } a dk_ token for the desktop assistant
 *
 * The local admin has no password anyone knows: the app signs it in with the key. That holds for the
 * admin the API made at its first start too: on its first use here its first password is replaced
 * and it is no longer asked to change it. In desktop mode POST /api/auth/register is closed too, so
 * no other program on the computer can claim the empty installation before the app does.
 */
export const LOCAL_ADMIN = { username: "local", email: "local@desktop.localhost" } as const;
export const DESKTOP_TOKEN_NAME = "Deploy King Desktop assistant";

// A few wrong keys a minute is plenty for the app; more is someone guessing. The right key always
// passes, so another program cannot lock the app out by guessing.
const failures: number[] = [];
const MAX_FAILURES_PER_MINUTE = 10;

function requireDesktopKey(req: Request, res: Response, next: NextFunction) {
  if (desktopKeyMatches(req.headers.authorization, readDesktopKey())) {
    next();
    return;
  }
  const now = Date.now();
  while (failures.length && now - failures[0]! > 60_000) failures.shift();
  failures.push(now);
  if (failures.length > MAX_FAILURES_PER_MINUTE) {
    res.status(429).json({ error: "Too many wrong keys. Wait a minute." });
    return;
  }
  res.status(401).json({ error: "Wrong or missing desktop key." });
}

/** A password nobody is told: the local admin is signed in with the key only. */
const unknownPassword = () => bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 12);

/** The built-in local admin: the first admin that is not suspended, made on first use when there is none. */
async function localAdmin(ip?: string) {
  const [have] = await db
    .select()
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.suspendedAt)))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (have) {
    if (!have.mustChangePassword) return have;
    // The admin the API makes at its first start has a first password and must change it at the first
    // sign-in. On a desktop machine nobody signs in with a password: the key is the credential, and a
    // session or token that first needs a password change is of no use to the app. So the change is no
    // longer asked for, and the first password (it is in the settings file and may be in the log) stops
    // working, like the password of the admin made below.
    const [fixed] = await db
      .update(users)
      .set({ mustChangePassword: false, passwordHash: await unknownPassword(), updatedAt: new Date() })
      .where(and(eq(users.id, have.id), eq(users.mustChangePassword, true)))
      .returning();
    if (fixed) {
      console.log(`[Desktop] "${fixed.username}" is the local admin: its first password is replaced and no password change is asked for.`);
      logAudit("user_update", { actorId: fixed.id, actorEmail: fixed.email, targetId: fixed.id, targetType: "user", targetName: fixed.username, metadata: { desktop: true, passwordChangeNoLongerRequired: true, firstPasswordReplaced: true }, ...(ip ? { ip } : {}) });
    }
    // Not updated: a second request did it at the same moment.
    return fixed ?? { ...have, mustChangePassword: false };
  }
  // A random password nobody is told: this account is signed in with the key only.
  const passwordHash = await unknownPassword();
  const [made] = await db
    .insert(users)
    .values({ username: LOCAL_ADMIN.username, email: LOCAL_ADMIN.email, passwordHash, role: "admin", teamRole: "admin", allApps: true })
    .onConflictDoNothing()
    .returning();
  if (made) {
    logAudit("user_create", { actorEmail: LOCAL_ADMIN.email, targetId: made.id, targetType: "user", targetName: made.username, metadata: { desktop: true } });
    return made;
  }
  // Made at the same moment by a second request.
  const [again] = await db.select().from(users).where(eq(users.username, LOCAL_ADMIN.username)).limit(1);
  if (!again) throw new Error("local admin could not be made");
  return again;
}

export function desktopRouter() {
  const r = Router();
  r.use(requireDesktopKey);

  r.post("/session", async (req, res) => {
    try {
      const u = await localAdmin(req.ip);
      const s = await issueSession(u);
      logAudit("login", { actorId: u.id, actorEmail: u.email, ip: req.ip, userAgent: "Deploy King Desktop", metadata: { via: "desktop-key" } });
      res.json({ token: s.token, user: s.user });
    } catch (e) {
      console.error("[Desktop] session failed:", e);
      res.status(500).json({ error: "Could not sign in the local admin." });
    }
  });

  r.post("/agent-token", async (req, res) => {
    try {
      const u = await localAdmin(req.ip);
      // One token for the desktop assistant at a time: the old one stops working.
      const old = await db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.userId, u.id), eq(apiTokens.name, DESKTOP_TOKEN_NAME), isNull(apiTokens.revokedAt)))
        .returning({ id: apiTokens.id });
      for (const o of old) logAudit("api_token_revoke", { actorId: u.id, targetId: o.id, targetType: "api_token", targetName: DESKTOP_TOKEN_NAME, ip: req.ip });
      const t = newToken();
      // "deploy": create, deploy, restart, roll back, change variables. Deleting an app stays a panel action.
      const [row] = await db
        .insert(apiTokens)
        .values({ userId: u.id, name: DESKTOP_TOKEN_NAME, scope: "deploy", tokenHash: t.hash, prefix: t.prefix, expiresAt: null })
        .returning({ id: apiTokens.id });
      logAudit("api_token_create", { actorId: u.id, targetId: row!.id, targetType: "api_token", targetName: DESKTOP_TOKEN_NAME, metadata: { scope: "deploy", desktop: true }, ip: req.ip });
      res.json({ token: t.raw });
    } catch (e) {
      console.error("[Desktop] agent token failed:", e);
      res.status(500).json({ error: "Could not make the assistant token." });
    }
  });
  return r;
}

/** Called once from index.ts, before the auth routes. Does nothing unless DESKTOP_MODE=true. */
export function mountDesktop(app: Express) {
  if (!desktopModeOn()) return;
  app.post("/api/auth/register", (_req, res) => {
    res.status(403).json({ error: "This is a Deploy King Desktop machine. The app signs you in by itself." });
  });
  app.use("/api/desktop", desktopRouter());
  console.log("[Desktop] desktop mode: key checked from", process.env.DESKTOP_KEY_FILE || "/etc/deploy-king/desktop.key");
}
