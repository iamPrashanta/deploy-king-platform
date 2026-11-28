/**
 * Terminals on connected servers, over the API's WebSocket gateway (/ws).
 *
 *   → { type: "ssh.open", serverId, cols, rows, password?, passphrase?, ticket? }
 *        ticket: on a desktop machine that requires tickets, a `change` ticket (checked in the gateway)
 *   ← { type: "ssh.opened", sessionId, serverId, recording, idleMinutes }
 *   ← { channel: "ssh", id: sessionId, payload: { data } }           output
 *   → { type: "ssh.input", id: sessionId, data }
 *   → { type: "ssh.resize", id: sessionId, cols, rows }
 *   → { type: "ssh.close", id: sessionId }
 *   ← { type: "ssh.closed", sessionId, reason }
 *   ← { type: "ssh.error", serverId, code, message }
 *
 * Admins only. The server's access rules decide whether the panel password is asked again, whether the
 * session is recorded (asciicast v2, output only, so typed passwords are never written) and when an idle
 * session closes. Recordings are kept for 30 days.
 */
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import bcrypt from "bcryptjs";
import { WebSocket } from "ws";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Client, ClientChannel } from "ssh2";
import { db, sshServers, sshSessions, users } from "@dbbkp/db";
import type { AuthedUser } from "../middleware/requireAuth";
import { SshError, shell } from "../services/ssh";
import { audit, openServer } from "../services/sshservers";

export const RECORDING_DAYS = 30;
export function recordingsDir() {
  return process.env.DK_SSH_RECORDINGS_DIR || "/var/lib/deploy-king/ssh-recordings";
}

type Live = {
  id: string;
  serverId: string;
  userId: string;
  username: string;
  ws: WebSocket;
  client: Client;
  stream: ClientChannel;
  rec: fs.WriteStream | null;
  recBytes: number;
  started: number;
  commands: number;
  idleMs: number;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
};
const live = new Map<string, Live>();

/** Sessions open right now, for the server page ("this session") and Disconnect. */
export function liveSessions(serverId?: string) {
  return [...live.values()].filter((l) => !serverId || l.serverId === serverId).map((l) => ({ id: l.id, serverId: l.serverId, userId: l.userId, username: l.username, startedAt: new Date(l.started) }));
}

// Re-typed panel passwords: a few tries, then a pause.
const tries = new Map<string, { n: number; until: number }>();

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function recordEvent(l: Live, kind: "o" | "r", data: string) {
  if (!l.rec) return;
  const line = JSON.stringify([Number(((Date.now() - l.started) / 1000).toFixed(3)), kind, data]) + "\n";
  l.recBytes += Buffer.byteLength(line);
  l.rec.write(line);
}

function armIdle(l: Live) {
  if (!l.idleMs) return;
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.idleTimer = setTimeout(() => {
    const msg = `\r\n\x1b[33m[Closed after ${Math.round(l.idleMs / 60000)} minutes without typing]\x1b[0m\r\n`;
    send(l.ws, { channel: "ssh", id: l.id, payload: { data: msg } });
    recordEvent(l, "o", msg);
    closeSession(l.id, "idle");
  }, l.idleMs);
}

export async function closeSession(id: string, reason: string) {
  const l = live.get(id);
  if (!l || l.closing) return;
  l.closing = true;
  live.delete(id);
  if (l.idleTimer) clearTimeout(l.idleTimer);
  try { l.stream.close(); } catch {}
  try { l.client.end(); } catch {}
  if (l.rec) await new Promise<void>((r) => l.rec!.end(() => r()));
  await db.update(sshSessions).set({ endedAt: new Date(), endReason: reason, commands: l.commands, recordingBytes: l.recBytes }).where(eq(sshSessions.id, id));
  const [s] = await db.select({ name: sshServers.name }).from(sshServers).where(eq(sshServers.id, l.serverId)).limit(1);
  audit("ssh_terminal_close", { id: l.userId }, { id: l.serverId, name: s?.name }, { sessionId: id, reason, commands: l.commands, seconds: Math.round((Date.now() - l.started) / 1000) });
  send(l.ws, { type: "ssh.closed", sessionId: id, reason });
}

/** Closes every live session on a server (the server page's Disconnect, or when a server is removed). */
export async function closeServerSessions(serverId: string, reason = "disconnected") {
  await Promise.all([...live.values()].filter((l) => l.serverId === serverId).map((l) => closeSession(l.id, reason)));
}

async function open(ws: WebSocket, user: AuthedUser, msg: any, ip: string | null) {
  const serverId = String(msg.serverId ?? "");
  const fail = (code: string, message: string) => send(ws, { type: "ssh.error", serverId, code, message });
  if (user.role !== "admin") {
    audit("ssh_terminal_denied", { id: user.sub, ip }, { id: /^[0-9a-f-]{36}$/i.test(serverId) ? serverId : undefined }, { reason: "not an admin" });
    return fail("FORBIDDEN", "Only admins can open a terminal on a server.");
  }
  if (!/^[0-9a-f-]{36}$/i.test(serverId)) return fail("NOT_FOUND", "Server not found");
  const [s] = await db.select().from(sshServers).where(eq(sshServers.id, serverId)).limit(1);
  if (!s) return fail("NOT_FOUND", "Server not found");
  const rules = s.rules;

  if (rules.askPassword) {
    const t = tries.get(user.sub);
    if (t && t.until > Date.now()) return fail("PASSWORD_LOCKED", "Too many wrong passwords. Wait a few minutes and try again.");
    if (!msg.password) return fail("PASSWORD_REQUIRED", "Type your Deploy King password to open the terminal.");
    const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.sub)).limit(1);
    const ok = !!u && (await bcrypt.compare(String(msg.password), u.hash));
    if (!ok) {
      const n = (t && t.until > Date.now() - 600_000 ? t.n : 0) + 1;
      tries.set(user.sub, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
      audit("ssh_terminal_denied", { id: user.sub, ip }, { id: s.id, name: s.name }, { reason: "wrong password" });
      return fail("PASSWORD_WRONG", "That is not your password.");
    }
    tries.delete(user.sub);
  }

  const cols = Math.max(20, Math.min(500, Number(msg.cols) || 80));
  const rows = Math.max(5, Math.min(200, Number(msg.rows) || 24));
  let client: Client;
  let stream: ClientChannel;
  try {
    const c = await openServer(s, { passphrase: msg.passphrase ? String(msg.passphrase) : undefined, requireTrusted: true, actor: { id: user.sub, ip } });
    client = c.client;
    stream = await shell(client, cols, rows);
  } catch (e: any) {
    const code = e instanceof SshError ? e.code.toUpperCase() : "ERROR";
    if (e instanceof SshError && e.code !== "passphrase") {
      await db.update(sshServers).set({ status: e.code === "hostkey" ? "host_key_changed" : e.code === "auth" ? "auth_failed" : "unreachable", ...(e.code === "hostkey" ? {} : { statusNote: e.message }) }).where(eq(sshServers.id, s.id));
    }
    return fail(code, e?.message ?? "The terminal could not be opened.");
  }
  // The browser may have gone away while the server was answering: do not leave a shell open for nobody.
  if (ws.readyState !== WebSocket.OPEN) {
    try { stream.close(); } catch {}
    client.end();
    return;
  }

  const [row] = await db.insert(sshSessions).values({ serverId: s.id, userId: user.sub, actor: user.username, ip }).returning();
  let rec: fs.WriteStream | null = null;
  if (rules.record) {
    try {
      fs.mkdirSync(recordingsDir(), { recursive: true, mode: 0o700 });
      const file = path.join(recordingsDir(), `${row.id}.cast`);
      rec = fs.createWriteStream(file, { mode: 0o600 });
      rec.on("error", (err) => console.error("[SSH] recording failed:", err.message));
      await db.update(sshSessions).set({ recordingPath: file }).where(eq(sshSessions.id, row.id));
    } catch (err: any) {
      console.error("[SSH] cannot record to", recordingsDir(), err.message);
    }
  }
  const l: Live = {
    id: row.id, serverId: s.id, userId: user.sub, username: user.username, ws, client, stream, rec, recBytes: 0,
    started: Date.now(), commands: 0, idleMs: (rules.idleMinutes || 0) * 60_000, idleTimer: null, closing: false,
  };
  live.set(l.id, l);
  if (rec) {
    const header = JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(l.started / 1000), title: `${s.username}@${s.name}`, env: { TERM: "xterm-256color" } }) + "\n";
    l.recBytes += Buffer.byteLength(header);
    rec.write(header);
  }
  const dec = new StringDecoder("utf8");
  const out = (buf: Buffer) => {
    const data = dec.write(buf);
    if (!data) return;
    recordEvent(l, "o", data);
    send(ws, { channel: "ssh", id: l.id, payload: { data } });
  };
  stream.on("data", out);
  stream.stderr.on("data", out);
  stream.on("close", () => closeSession(l.id, "server-closed"));
  client.on("error", () => closeSession(l.id, "error"));
  client.on("close", () => closeSession(l.id, "server-closed"));
  armIdle(l);
  await db.update(sshServers).set({ lastUsedAt: new Date() }).where(eq(sshServers.id, s.id));
  audit("ssh_terminal_open", { id: user.sub, ip }, { id: s.id, name: s.name }, { sessionId: l.id, recording: !!rec });
  send(ws, { type: "ssh.opened", sessionId: l.id, serverId: s.id, recording: !!rec, idleMinutes: rules.idleMinutes });
}

/** Handles an "ssh.*" message from the gateway. Every session belongs to the socket that opened it. */
export async function handleSshMessage(ws: WebSocket, user: AuthedUser, msg: any, ip: string | null = null) {
  const { type, id } = msg;
  if (type === "ssh.open") return open(ws, user, msg, ip);
  const l = typeof id === "string" ? live.get(id) : undefined;
  if (!l || l.ws !== ws) return;
  if (type === "ssh.input") {
    const data = typeof msg.data === "string" ? msg.data : "";
    if (!data) return;
    l.stream.write(data);
    l.commands += (data.match(/\r/g) ?? []).length;
    armIdle(l);
  } else if (type === "ssh.resize") {
    const cols = Math.max(20, Math.min(500, Number(msg.cols) || 80));
    const rows = Math.max(5, Math.min(200, Number(msg.rows) || 24));
    l.stream.setWindow(rows, cols, 0, 0);
    recordEvent(l, "r", `${cols}x${rows}`);
  } else if (type === "ssh.close") {
    await closeSession(l.id, "ended");
  }
}

/** The socket went away: its sessions end. */
export function closeSocketSessions(ws: WebSocket) {
  for (const l of live.values()) if (l.ws === ws) closeSession(l.id, "disconnected");
}

/** Deletes recordings older than 30 days. Runs hourly once the gateway is up. */
export async function pruneRecordings(now = Date.now()) {
  const cutoff = new Date(now - RECORDING_DAYS * 86_400_000);
  const old = await db.select({ id: sshSessions.id, path: sshSessions.recordingPath }).from(sshSessions)
    .where(and(isNotNull(sshSessions.recordingPath), lt(sshSessions.startedAt, cutoff)));
  for (const o of old) {
    try { if (o.path) fs.rmSync(o.path, { force: true }); } catch {}
    await db.update(sshSessions).set({ recordingPath: null }).where(eq(sshSessions.id, o.id));
  }
  return old.length;
}

let pruner: NodeJS.Timeout | null = null;
export function startSshHousekeeping() {
  if (pruner) return;
  pruneRecordings().catch(() => {});
  pruner = setInterval(() => pruneRecordings().catch((e) => console.error("[SSH] prune failed:", e.message)), 3600_000);
  pruner.unref();
}
