import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, users, sessions } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import crypto from "node:crypto";
import { logAudit } from "@dbbkp/audit";
import { nextStep } from "../services/twofactor";
import { checkLimit, noteFailure } from "../services/ratelimit";

const router = Router();

import { JWT_SECRET } from "../config";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { username, password } = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

    // The same limit on wrong passwords per address as the panel's sign-in.
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] || req.socket.remoteAddress || null;
    try {
      checkLimit("password", ip);
    } catch (e: any) {
      return res.status(429).json({ error: e.message });
    }

    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

    if (!user) {
      noteFailure("password", ip);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      noteFailure("password", ip);
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (user.suspendedAt) {
      return res.status(403).json({ error: "This account is suspended. Ask the owner of this panel." });
    }
    // This older route has no second step. Accounts with 2-step sign-in (or that must set it up) sign in through the panel.
    if ((await nextStep(user)) !== "none") {
      return res.status(403).json({ error: "This account uses 2-step sign-in. Sign in through the panel." });
    }

    // 1. Create Session in DB
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      expiresAt,
    });

    // 2. Generate JWT with Session ID
    const token = jwt.sign(
      { 
        sub: user.id, 
        sid: sessionId, 
        username: user.username, 
        role: user.role 
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES } as jwt.SignOptions
    );

    // Fire-and-forget audit log
    logAudit("login", {
      actorId: user.id,
      actorEmail: user.email,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.json({
      token,
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        role: user.role,
        mustChangePassword: user.mustChangePassword 
      },
    });
  } catch (err: any) {
    if (err?.name === "ZodError") return res.status(400).json({ error: "Invalid request body" });
    console.error("[Auth] Login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req: any, res) => {
  try {
    const [user] = await db.select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    }).from(users).where(eq(users.id, req.user.sub)).limit(1);

    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/auth/register (first-time setup only) ──────────────────
router.post("/register", async (req, res) => {
  try {
    // Creates the first account on an empty installation and nothing else. Once anyone exists, accounts
    // come from an invitation or an approved access request (see team.router.ts); this route used to
    // accept anyone, with any role, without signing in.
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);
    if (existing) {
      return res.status(403).json({ error: "Registration is closed. Ask the owner of this panel for an invitation, or request access on the sign-up page." });
    }

    const { username, email, password } = z.object({
      username: z.string().min(3).max(50),
      email: z.string().email(),
      password: z.string().min(12),
    }).parse(req.body);

    const passwordHash = await bcrypt.hash(password, 12);

    const [created] = await db.insert(users).values({
      username,
      email,
      passwordHash,
      role: "admin",
    }).returning({ id: users.id, username: users.username, role: users.role });

    logAudit("user_create", {
      actorEmail: email,
      targetId: created.id,
      targetType: "user",
      targetName: username,
      ip: req.ip,
    });

    return res.status(201).json({ user: created });
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "Username or email already exists" });
    if (err?.name === "ZodError") return res.status(400).json({ error: err.issues });
    console.error("[Auth] Register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
export function requireAuth(req: any, res: any, next: any) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(req: any, res: any, next: any) {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
}

export default router;
