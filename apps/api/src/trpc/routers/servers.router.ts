// Servers & SSH: other servers this panel signs in to. Admins only, like nodes.router.ts.
// Secrets (private keys, stored passwords) never leave the API; see services/sshservers.ts.
import fs from "node:fs";
import os from "node:os";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db, auditLogs, sshKeys, sshServers, sshSessions, users, type SshAccessRules } from "@dbbkp/db";
import { encrypt } from "@dbbkp/security";
import { router, adminProcedure } from "../trpc";
import { KEY_TYPES, SAFE_FROM, SAFE_LABEL, SshError, inspectPrivateKey } from "../../services/ssh";
import {
  audit, bad, createKey, defaultRules, getSettings, installInfo, installWithPassword, loadKey, loadServer, lockAddress, notFound, probe,
  publicKey, publicServer, rotateKey, runChecks, saveSettings, setStoredPassword, trust, type Actor,
} from "../../services/sshservers";
import { closeServerSessions, liveSessions } from "../../ws/ssh";

const id = z.string().uuid();
const name = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, "A name may use letters, digits and . _ - only.");
const host = z.string().trim().regex(/^[A-Za-z0-9.:\-\[\]]{1,253}$/, "Type a host name or an IP address.");
const username = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/, "Type a user name such as deploy.");
const port = z.number().int().min(1).max(65535);
const keyType = z.enum(KEY_TYPES as [string, ...string[]]);
const label = z.string().trim().regex(SAFE_LABEL, "A label may use letters, digits and @ . _ + - only, without spaces.");
const rotateDays = z.number().int().min(1).max(3650).nullable();
const rules = z.object({
  adminsOnly: z.boolean(),
  askPassword: z.boolean(),
  record: z.boolean(),
  idleMinutes: z.number().min(0).max(24 * 60), // whole minutes in the panel; checks use a fraction
  allowAutomation: z.boolean(),
});

const actorOf = (ctx: any): Actor => ({ id: ctx.user.sub, username: ctx.user.username, ip: ctx.ip });

/** SSH failures become plain sentences for the panel. */
async function friendly<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e: any) {
    if (e instanceof SshError) throw new TRPCError({ code: e.code === "hostkey" ? "CONFLICT" : "BAD_REQUEST", message: e.message });
    throw e;
  }
}

async function keyUse() {
  const rows = await db.select({ id: sshServers.id, name: sshServers.name, keyId: sshServers.keyId, status: sshServers.status }).from(sshServers).where(isNotNull(sshServers.keyId));
  const m = new Map<string, Array<{ id: string; name: string; status: string }>>();
  for (const r of rows) m.set(r.keyId!, [...(m.get(r.keyId!) ?? []), { id: r.id, name: r.name, status: r.status }]);
  return m;
}

function localServer() {
  let osName = os.type();
  try {
    const rel = fs.readFileSync("/etc/os-release", "utf8");
    osName = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1] ?? osName;
  } catch {}
  return { name: os.hostname(), os: osName, cpus: os.cpus().length, memoryMb: Math.round(os.totalmem() / 1048576) };
}

export const serversRouter = router({
  list: adminProcedure.query(async () => {
    const rows = await db.select().from(sshServers).orderBy(sshServers.name);
    const keys = rows.some((r) => r.keyId) ? await db.select().from(sshKeys).where(inArray(sshKeys.id, rows.filter((r) => r.keyId).map((r) => r.keyId!))) : [];
    const live = liveSessions();
    return {
      local: localServer(),
      servers: rows.map((r) => ({ ...publicServer(r, keys.find((k) => k.id === r.keyId)), liveSessions: live.filter((l) => l.serverId === r.id).length })),
    };
  }),

  get: adminProcedure.input(z.object({ id })).query(async ({ input }) => {
    const s = await loadServer(input.id);
    const key = s.keyId ? await loadKey(s.keyId) : null;
    const settings = await getSettings();
    return {
      ...publicServer(s, key),
      install: key ? installInfo(key) : null,
      panelAddress: lockAddress(settings),
      live: liveSessions(s.id),
    };
  }),

  create: adminProcedure
    .input(z.object({ name, host, port: port.default(22), username, authMethod: z.enum(["key", "password-once", "password"]), timeoutSec: z.number().int().min(3).max(120).default(10), jumpServerId: id.nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const settings = await getSettings();
      if (input.authMethod === "password" && !settings.allowPasswordSignIn) throw bad("Password sign-in to servers is turned off under SSH keys, Security defaults. Choose a key.");
      const [dup] = await db.select({ id: sshServers.id }).from(sshServers).where(eq(sshServers.name, input.name)).limit(1);
      if (dup) throw new TRPCError({ code: "CONFLICT", message: `There is already a server called ${input.name}.` });
      if (input.jumpServerId) await loadServer(input.jumpServerId);
      const [row] = await db.insert(sshServers).values({
        name: input.name, host: input.host, port: input.port, username: input.username, authMethod: input.authMethod,
        timeoutSec: input.timeoutSec, jumpServerId: input.jumpServerId ?? null, rules: defaultRules(settings),
        status: "waiting_key", statusNote: "Setup not finished", createdBy: ctx.user!.sub,
      }).returning();
      audit("ssh_server_add", actorOf(ctx), { id: row.id, name: row.name }, { host: row.host, port: row.port, user: row.username, authMethod: row.authMethod });
      return publicServer(row);
    }),

  update: adminProcedure
    .input(z.object({ id, name, host, port, username, timeoutSec: z.number().int().min(3).max(120), jumpServerId: id.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const s = await loadServer(input.id);
      if (input.jumpServerId === s.id) throw bad("A server cannot be its own jump server.");
      const [dup] = await db.select({ id: sshServers.id }).from(sshServers).where(eq(sshServers.name, input.name)).limit(1);
      if (dup && dup.id !== s.id) throw new TRPCError({ code: "CONFLICT", message: `There is already a server called ${input.name}.` });
      // The trusted fingerprint stays: if the new address is another machine, connecting is refused.
      await db.update(sshServers).set({ name: input.name, host: input.host, port: input.port, username: input.username, timeoutSec: input.timeoutSec, jumpServerId: input.jumpServerId, updatedAt: new Date() }).where(eq(sshServers.id, s.id));
      audit("ssh_server_update", actorOf(ctx), { id: s.id, name: input.name }, { host: input.host, port: input.port, user: input.username });
      return { ok: true };
    }),

  remove: adminProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.id);
    await closeServerSessions(s.id, "server removed");
    for (const r of await db.select({ id: sshSessions.id, path: sshSessions.recordingPath }).from(sshSessions).where(eq(sshSessions.serverId, s.id))) {
      if (r.path) fs.rmSync(r.path, { force: true });
    }
    await db.delete(sshServers).where(eq(sshServers.id, s.id));
    audit("ssh_server_delete", actorOf(ctx), { id: s.id, name: s.name });
    return { ok: true };
  }),

  /** Step 2: a new key pair for this server. "Generate again" replaces a key that never reached the server. */
  prepareKey: adminProcedure
    .input(z.object({ serverId: id, type: keyType, label, passphrase: z.string().min(8).max(200).optional(), lock: z.boolean(), restrict: z.boolean(), rotateDays }))
    .mutation(async ({ ctx, input }) => {
      const s = await loadServer(input.serverId);
      if (s.status !== "waiting_key" && s.keyId) throw bad("This server already has a working key. Rotate it on the SSH keys page.");
      const previous = s.keyId;
      const k = await createKey({ type: input.type as any, label: input.label, passphrase: input.passphrase, lock: input.lock, restrict: input.restrict, rotateDays: input.rotateDays, actor: actorOf(ctx) });
      await db.update(sshServers).set({ keyId: k.id, authMethod: s.authMethod === "password" ? "key" : s.authMethod, updatedAt: new Date() }).where(eq(sshServers.id, s.id));
      if (previous) {
        const others = await db.select({ id: sshServers.id }).from(sshServers).where(eq(sshServers.keyId, previous));
        const [old] = await db.select().from(sshKeys).where(eq(sshKeys.id, previous)).limit(1);
        if (old && others.length === 0 && !old.imported && !old.lastUsedAt) await db.delete(sshKeys).where(eq(sshKeys.id, previous));
      }
      return { key: publicKey(k), install: installInfo(k) };
    }),

  /** Step 2, "Use a key I already have". */
  useKey: adminProcedure.input(z.object({ serverId: id, keyId: id })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.serverId);
    const k = await loadKey(input.keyId);
    await db.update(sshServers).set({ keyId: k.id, authMethod: s.authMethod === "password" ? "key" : s.authMethod, status: s.hostKeyFingerprint ? s.status : "waiting_key", updatedAt: new Date() }).where(eq(sshServers.id, s.id));
    audit("ssh_server_update", actorOf(ctx), { id: s.id, name: s.name }, { key: k.fingerprint });
    return { key: publicKey(k), install: installInfo(k) };
  }),

  /** "Install it for me": the password is used for this one connection and never stored. */
  installKey: adminProcedure.input(z.object({ serverId: id, password: z.string().min(1).max(500) })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.serverId);
    return friendly(installWithPassword(s, input.password, actorOf(ctx)));
  }),

  /** "Password every time": stored encrypted, used for every connection. */
  setPassword: adminProcedure.input(z.object({ serverId: id, password: z.string().min(1).max(500) })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.serverId);
    await setStoredPassword(s, input.password, actorOf(ctx));
    return { ok: true };
  }),

  /** Step 3: the fingerprint the server shows. */
  probe: adminProcedure.input(z.object({ id })).mutation(async ({ input }) => friendly(probe(await loadServer(input.id)))),

  trust: adminProcedure.input(z.object({ id, fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/), replace: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.id);
    return friendly(trust(s, input.fingerprint, actorOf(ctx), { replace: input.replace }));
  }),

  test: adminProcedure.input(z.object({ id, passphrase: z.string().max(200).optional() })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.id);
    return runChecks(s, { passphrase: input.passphrase, actor: actorOf(ctx) });
  }),

  setRules: adminProcedure.input(z.object({ id, rules })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.id);
    // Servers are for admins only in this version, so the first rule cannot be turned off yet.
    const next = { ...input.rules, adminsOnly: true } as SshAccessRules;
    await db.update(sshServers).set({ rules: next, updatedAt: new Date() }).where(eq(sshServers.id, s.id));
    audit("ssh_server_update", actorOf(ctx), { id: s.id, name: s.name }, { rules: next });
    return { ok: true, rules: next };
  }),

  /** Step 3, "Add server": only once the fingerprint is trusted. */
  finish: adminProcedure.input(z.object({ id, rules })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.id);
    if (!s.hostKeyFingerprint) throw bad("Confirm the server's fingerprint first.");
    if (s.authMethod === "password" ? !s.encryptedPassword : !s.keyId) throw bad("Deploy King cannot sign in to this server yet.");
    const next = { ...input.rules, adminsOnly: true } as SshAccessRules;
    await db.update(sshServers).set({ rules: next, setupDone: true, updatedAt: new Date() }).where(eq(sshServers.id, s.id));
    audit("ssh_server_update", actorOf(ctx), { id: s.id, name: s.name }, { setupDone: true, rules: next });
    return { ok: true };
  }),

  disconnect: adminProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const s = await loadServer(input.id);
    const n = liveSessions(s.id).length;
    await closeServerSessions(s.id, "disconnected");
    return { closed: n };
  }),

  sessions: adminProcedure.input(z.object({ id, limit: z.number().int().min(1).max(200).default(20) })).query(async ({ input }) => {
    const rows = await db.select().from(sshSessions).where(eq(sshSessions.serverId, input.id)).orderBy(desc(sshSessions.startedAt)).limit(input.limit);
    const live = new Set(liveSessions(input.id).map((l) => l.id));
    return rows.map((r) => ({
      id: r.id, actor: r.actor, userId: r.userId, startedAt: r.startedAt, endedAt: r.endedAt, endReason: r.endReason, commands: r.commands,
      live: live.has(r.id), recorded: !!r.recordingPath && fs.existsSync(r.recordingPath), recordingBytes: r.recordingBytes,
    }));
  }),

  /** A recorded session, for Replay (asciicast v2). */
  recording: adminProcedure.input(z.object({ sessionId: id })).query(async ({ ctx, input }) => {
    const [r] = await db.select().from(sshSessions).where(eq(sshSessions.id, input.sessionId)).limit(1);
    if (!r?.recordingPath || !fs.existsSync(r.recordingPath)) throw notFound("Recording");
    const size = fs.statSync(r.recordingPath).size;
    if (size > 8 * 1024 * 1024) throw bad("This recording is too large to replay in the browser.");
    audit("ssh_terminal_open", actorOf(ctx), { id: r.serverId }, { replay: r.id });
    return { id: r.id, actor: r.actor, startedAt: r.startedAt, cast: fs.readFileSync(r.recordingPath, "utf8") };
  }),

  activity: adminProcedure.input(z.object({ id, limit: z.number().int().min(1).max(500).default(100) })).query(async ({ input }) => {
    return db.select({ id: auditLogs.id, action: auditLogs.action, metadata: auditLogs.metadata, ip: auditLogs.ip, createdAt: auditLogs.createdAt, actor: users.username })
      .from(auditLogs).leftJoin(users, eq(auditLogs.actorId, users.id))
      .where(eq(auditLogs.targetId, input.id)).orderBy(desc(auditLogs.createdAt)).limit(input.limit);
  }),

  // ─── SSH keys page ──────────────────────────────────────────────────────────
  keys: adminProcedure.query(async () => {
    const rows = await db.select().from(sshKeys).orderBy(desc(sshKeys.createdAt));
    const use = await keyUse();
    return rows.map((k) => ({ ...publicKey(k), usedBy: use.get(k.id) ?? [] }));
  }),

  generateKey: adminProcedure
    .input(z.object({ type: keyType, label, passphrase: z.string().min(8).max(200).optional(), lock: z.boolean(), restrict: z.boolean(), rotateDays }))
    .mutation(async ({ ctx, input }) => {
      const k = await createKey({ type: input.type as any, label: input.label, passphrase: input.passphrase, lock: input.lock, restrict: input.restrict, rotateDays: input.rotateDays, actor: actorOf(ctx) });
      return { key: publicKey(k), install: installInfo(k) };
    }),

  importKey: adminProcedure
    .input(z.object({ label, privateKey: z.string().min(64).max(20_000), passphrase: z.string().max(200).optional(), lock: z.boolean(), restrict: z.boolean(), rotateDays }))
    .mutation(async ({ ctx, input }) => {
      let info;
      try {
        info = inspectPrivateKey(input.privateKey.trim() + "\n", input.label, input.passphrase || undefined);
      } catch (e: any) {
        throw bad(e.message);
      }
      const [dup] = await db.select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.fingerprint, info.fingerprint)).limit(1);
      if (dup) throw new TRPCError({ code: "CONFLICT", message: "This key is already here." });
      const settings = await getSettings();
      const enc = encrypt(input.privateKey.trim() + "\n");
      const [k] = await db.insert(sshKeys).values({
        label: input.label, type: info.type, publicKey: info.publicKey, fingerprint: info.fingerprint,
        encryptedPrivateKey: enc.encryptedValue, iv: enc.iv, authTag: enc.authTag, hasPassphrase: info.hasPassphrase, imported: true,
        fromAddress: input.lock ? lockAddress(settings) ?? "" : null, restrict: input.restrict, rotateAfterDays: input.rotateDays, createdBy: ctx.user!.sub,
      }).returning();
      audit("ssh_key_import", actorOf(ctx), { id: k.id, type: "ssh_key", name: k.label }, { type: k.type, fingerprint: k.fingerprint });
      return { key: publicKey(k), install: installInfo(k) };
    }),

  deleteKey: adminProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const k = await loadKey(input.id);
    const used = (await keyUse()).get(k.id) ?? [];
    if (used.length) throw bad(`${used.map((u) => u.name).join(", ")} still uses this key. Rotate it or choose another key there first.`);
    await db.delete(sshKeys).where(eq(sshKeys.id, k.id));
    audit("ssh_key_delete", actorOf(ctx), { id: k.id, type: "ssh_key", name: k.label }, { fingerprint: k.fingerprint });
    return { ok: true };
  }),

  rotateKey: adminProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => friendly(rotateKey(input.id, actorOf(ctx)))),

  settings: adminProcedure.query(async () => {
    const s = await getSettings();
    return { ...s, effectiveAddress: lockAddress(s), envAddress: process.env.DK_PANEL_ADDRESS || null };
  }),

  saveSettings: adminProcedure
    .input(z.object({
      keyType, rotateDays, lockToPanel: z.boolean(), askPassword: z.boolean(), record: z.boolean(), allowPasswordSignIn: z.boolean(),
      panelAddress: z.string().trim().regex(SAFE_FROM, "Type an IP address, a range like 203.0.113.0/24, or a host name.").nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const prev = await getSettings();
      const next = { ...prev, ...input, keyType: input.keyType as any };
      await saveSettings(next, ctx.user!.sub);
      audit("ssh_settings", actorOf(ctx), { type: "settings", name: "ssh" }, input);
      return { ok: true };
    }),
});
