/**
 * Unified WebSocket Gateway
 *
 * All real-time channels multiplexed over a single ws://api/ws endpoint.
 *
 * Channel types:
 *   logs      — build / deployment log streaming (by jobId)
 *   metrics   — live node metrics streaming (by nodeId)
 *   terminal  — PTY shell sessions (by sessionId)
 *   containers— docker container log streaming (by containerId)
 *
 * Message envelope (inbound from client):
 *   { type: "subscribe", channel: "logs",     id: "<jobId>" }
 *   { type: "subscribe", channel: "metrics",  id: "<nodeId>" }
 *   { type: "subscribe", channel: "terminal", id: "<sessionId>", data: "<stdin>" }
 *   { type: "subscribe", channel: "containers", id: "<containerId>" }
 *
 * Message envelope (outbound to client):
 *   { channel: "logs",      id, payload: { type, message, ts } }
 *   { channel: "metrics",   id, payload: { cpu, memory, disk, ts } }
 *   { channel: "terminal",  id, payload: { data: "<stdout>" } }
 *   { channel: "containers",id, payload: { line, ts } }
 */

import { visibleSite } from "../services/team";
import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import type { IncomingMessage } from "http";
import { spawn } from "node-pty";
import Docker from "dockerode";
import crypto from "node:crypto";
import { db, terminalSessions, containerInstances, sites } from "@dbbkp/db";
import { eq, and } from "drizzle-orm";
import { verifyToken, type AuthedUser } from "../middleware/requireAuth";
import { logAudit } from "@dbbkp/audit";
import { hasPermission, PERMISSIONS } from "../utils/rbac";
import { ExecutionBroker } from "@dbbkp/runner";
import { handleSshMessage, closeSocketSessions, startSshHousekeeping } from "./ssh";

const docker = new Docker();

// ─── Subscription registries ──────────────────────────────────────────────────
// channel:id → Set of connected clients
const subscriptions = new Map<string, Set<WebSocket>>();

// ─── Terminal sessions ─────────────────────────────────────────────────────────
interface TermEntry {
  pty: ReturnType<typeof spawn>;
  sessionId: string;
  recording: string[];
}
const terminalMap = new Map<string, TermEntry>(); // sessionId → TermEntry

// ─── Docker log streams ────────────────────────────────────────────────────────
const containerStreams = new Map<string, NodeJS.ReadableStream>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function subKey(channel: string, id: string) {
  return `${channel}:${id}`;
}

function subscribe(channel: string, id: string, ws: WebSocket) {
  const key = subKey(channel, id);
  if (!subscriptions.has(key)) subscriptions.set(key, new Set());
  subscriptions.get(key)!.add(ws);
}

function unsubscribe(channel: string, id: string, ws: WebSocket) {
  subscriptions.get(subKey(channel, id))?.delete(ws);
}

function publish(channel: string, id: string, payload: unknown) {
  const key = subKey(channel, id);
  const clients = subscriptions.get(key);
  if (!clients || clients.size === 0) return;
  const msg = JSON.stringify({ channel, id, payload });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

/**
 * Resolves a container reference (docker id, or the container name the panel
 * holds in sites.pm2Name) to the site it belongs to, and returns the site id
 * only if this user may access it. Admins may access any platform-managed
 * container; nobody may reach containers the platform does not manage
 * (the platform's own Postgres/Redis, for example).
 */
async function validateContainerOwnership(containerRef: string, user: AuthedUser): Promise<string | null> {
  let siteId: string | null = null;

  const [instance] = await db
    .select({ siteId: containerInstances.siteId })
    .from(containerInstances)
    .where(eq(containerInstances.dockerId, containerRef))
    .limit(1);
  siteId = instance?.siteId ?? null;

  if (!siteId) {
    const [byName] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.pm2Name, containerRef))
      .limit(1);
    siteId = byName?.id ?? null;
  }

  if (!siteId) return null;
  // Same rule as the API: admins see every app, a member sees their own plus the ones shared with them.
  const site = await visibleSite(user, siteId);
  return site ? site.id : null;
}

// ─── Terminal helpers ─────────────────────────────────────────────────────────

async function openTerminal(
  ws: WebSocket,
  containerId: string,
  userId: string,
  siteId?: string
): Promise<string> {
  const sessionId = crypto.randomUUID();

  // Open PTY to docker exec inside the container
  // 0. Policy Validation via Execution Broker
  try {
    await ExecutionBroker.validateIntent({
      type: "docker.exec",
      actorId: userId,
      targetId: containerId,
      command: "docker",
      args: ["exec", "-it", containerId, "/bin/sh"],
    });
  } catch (err: any) {
    ws.send(JSON.stringify({ error: `Security Policy Violation: ${err.message}` }));
    return "";
  }

  const pty = spawn("docker", ["exec", "-it", containerId, "/bin/sh"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
  });

  const entry: TermEntry = { pty, sessionId, recording: [] };
  terminalMap.set(sessionId, entry);

  // Stream stdout → browser
  pty.onData((data) => {
    entry.recording.push(data);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ channel: "terminal", id: sessionId, payload: { data } }));
    }
  });

  pty.onExit(() => {
    // Save recording & close session
    closeTerminal(sessionId, userId);
  });

  // Record in DB
  await db.insert(terminalSessions).values({
    id: sessionId,
    userId,
    siteId: siteId ?? null,
    sessionType: "container",
    targetContainerId: containerId,
    status: "active",
  });

  logAudit("deploy", {
    actorId: userId,
    targetId: siteId,
    targetType: "terminal",
    targetName: containerId,
    metadata: { sessionId },
  });

  return sessionId;
}

async function closeTerminal(sessionId: string, userId?: string) {
  const entry = terminalMap.get(sessionId);
  if (!entry) return;
  try { entry.pty.kill(); } catch {}
  terminalMap.delete(sessionId);

  // Persist recording and close session
  const recording = entry.recording.join("");
  await db.update(terminalSessions)
    .set({ status: "closed", endedAt: new Date(), recording })
    .where(eq(terminalSessions.id, sessionId));

  logAudit("deploy", { actorId: userId, metadata: { sessionId, action: "terminal_closed" } });
}

// ─── Docker log streaming ─────────────────────────────────────────────────────

async function streamContainerLogs(containerId: string) {
  if (containerStreams.has(containerId)) return; // already streaming

  try {
    const container = docker.getContainer(containerId);
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
    });
    containerStreams.set(containerId, stream);

    stream.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").replace(/^\s*[\x00-\x09\x0b-\x1f]/, ""); // strip docker framing byte
      publish("containers", containerId, { line, ts: Date.now() });
    });

    stream.on("end", () => {
      containerStreams.delete(containerId);
    });

    stream.on("error", () => {
      containerStreams.delete(containerId);
    });
  } catch (err) {
    console.error(`[WS:containers] Failed to stream logs for ${containerId}:`, err);
  }
}

// ─── Main WS Gateway setup ────────────────────────────────────────────────────

export function setupWebSocketGateway(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    // ── Authentication ──────────────────────────────────────────────────────
    // Same rule as HTTP: valid JWT *and* a live server-side session, so a
    // revoked session (logout, password change) cannot keep a socket open.
    const url = new URL(req.url!, "http://localhost");
    const token = url.searchParams.get("token");

    // Messages can arrive while the session lookup is in flight; hold them.
    const pending: any[] = [];
    const hold = (raw: any) => pending.push(raw);
    ws.on("message", hold);

    let user: AuthedUser | null = null;
    try {
      user = await verifyToken(token);
    } catch (err) {
      console.error("[WS] Auth lookup failed:", err);
    }

    if (!user) {
      ws.close(4001, "Unauthorized");
      return;
    }
    ws.off("message", hold);

    console.log(`[WS] Client connected: ${user.sub}`);

    const onMessage = async (raw: any) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const { type, channel, id, data, cols, rows } = msg;

      // ── subscribe to a channel ────────────────────────────────────────────
      if (type === "subscribe") {
        if (!channel || !id) {
          ws.send(JSON.stringify({ error: "channel and id required" }));
          return;
        }

        // Authorise before subscribing. Without this any logged-in user could
        // stream the logs of any container on the host by guessing its name.
        if (channel === "containers") {
          const siteId = await validateContainerOwnership(id, user!);
          if (!siteId) {
            ws.send(JSON.stringify({ error: "Unauthorized access to container", channel, id }));
            return;
          }
        } else if (channel === "metrics") {
          const allowed = await hasPermission(user!.sub, PERMISSIONS.NODE_MANAGE);
          if (!allowed) {
            ws.send(JSON.stringify({ error: "Permission denied: node.manage", channel, id }));
            return;
          }
        } else if (channel !== "logs") {
          ws.send(JSON.stringify({ error: `Unknown channel: ${channel}` }));
          return;
        }

        subscribe(channel, id, ws);

        if (channel === "containers") {
          // Start docker log stream if not already running
          streamContainerLogs(id).catch(console.error);
        }

        ws.send(JSON.stringify({ type: "subscribed", channel, id }));
      }

      // ── open a terminal to a container ────────────────────────────────────
      else if (type === "terminal.open") {
        if (!id) { ws.send(JSON.stringify({ error: "containerId required" })); return; }
        
        // 1. RBAC check
        const canOpen = await hasPermission(user!.sub, PERMISSIONS.TERMINAL_OPEN);
        if (!canOpen) {
          ws.send(JSON.stringify({ error: "Permission denied: terminal.open" }));
          return;
        }

        // 2. Ownership check
        const siteId = await validateContainerOwnership(id, user!);
        if (!siteId) {
          ws.send(JSON.stringify({ error: "Unauthorized access to container" }));
          return;
        }

        const sessionId = await openTerminal(ws, id, user!.sub, siteId);
        ws.send(JSON.stringify({ type: "terminal.opened", sessionId }));
      }

      // ── send stdin to an open terminal ────────────────────────────────────
      else if (type === "terminal.input") {
        const canWrite = await hasPermission(user!.sub, PERMISSIONS.TERMINAL_WRITE);
        if (!canWrite) return; // Silent drop

        const entry = terminalMap.get(id);
        if (entry) {
          entry.pty.write(data ?? "");
          // Update last activity for reaper
          await db
            .update(terminalSessions)
            .set({ lastActivityAt: new Date() })
            .where(eq(terminalSessions.id, id));
        }
      }

      // ── resize terminal ───────────────────────────────────────────────────
      else if (type === "terminal.resize") {
        const entry = terminalMap.get(id);
        if (entry && cols && rows) {
          entry.pty.resize(cols, rows);
        }
      }

      // ── close terminal ────────────────────────────────────────────────────
      else if (type === "terminal.close") {
        await closeTerminal(id, user!.sub);
        ws.send(JSON.stringify({ type: "terminal.closed", sessionId: id }));
      }

      // ── terminals on connected servers (Servers & SSH, see ws/ssh.ts) ─────
      else if (typeof type === "string" && type.startsWith("ssh.")) {
        const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] || req.socket.remoteAddress || null;
        await handleSshMessage(ws, user!, msg, ip);
      }

      // ── unsubscribe ───────────────────────────────────────────────────────
      else if (type === "unsubscribe") {
        if (channel && id) unsubscribe(channel, id, ws);
      }
    };

    ws.on("message", (raw) => {
      onMessage(raw).catch((err) => console.error("[WS] Handler error:", err));
    });
    for (const raw of pending) {
      onMessage(raw).catch((err) => console.error("[WS] Handler error:", err));
    }

    ws.on("close", () => {
      closeSocketSessions(ws);
      // Unsubscribe from all channels
      for (const [key, clients] of subscriptions) {
        clients.delete(ws);
        if (clients.size === 0) subscriptions.delete(key);
      }
      console.log(`[WS] Client disconnected: ${user!.sub}`);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error for ${user!.sub}:`, err.message);
    });

    ws.send(JSON.stringify({ type: "connected", ts: Date.now() }));
  });

  console.log("[WS] Unified gateway ready on /ws");
  startSshHousekeeping();

  // ─── Session Reaper ────────────────────────────────────────────────────────
  // Runs every minute to close idle or orphaned terminal sessions
  setInterval(async () => {
    const now = Date.now();
    const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
    const MAX_SESSION_TIME = 2 * 60 * 60 * 1000; // 2 hours absolute max

    for (const [sessionId, entry] of terminalMap.entries()) {
      const [dbSession] = await db
        .select()
        .from(terminalSessions)
        .where(eq(terminalSessions.id, sessionId))
        .limit(1);

      if (!dbSession) {
        closeTerminal(sessionId);
        continue;
      }

      const lastActivity = new Date(dbSession.lastActivityAt ?? dbSession.startedAt!).getTime();
      const startedAt = new Date(dbSession.startedAt!).getTime();

      if (now - lastActivity > IDLE_TIMEOUT || now - startedAt > MAX_SESSION_TIME) {
        console.log(`[WS:Reaper] Closing stale session: ${sessionId}`);
        closeTerminal(sessionId, dbSession.userId!);
      }
    }
  }, 60_000);

  return wss;
}

// ─── Broadcast helpers (called by workers / API routes) ───────────────────────

/** Broadcast a log line to all subscribers of a job stream */
export function broadcastLog(jobId: string, message: string, type: "log" | "error" | "done" = "log") {
  publish("logs", jobId, { type, message, ts: Date.now() });
}

/** Broadcast live metrics to all subscribers of a node */
export function broadcastMetrics(nodeId: string, metrics: Record<string, number>) {
  publish("metrics", nodeId, { ...metrics, ts: Date.now() });
}

/** Broadcast a generic event to all subscribers of a channel */
export function broadcastEvent(channel: string, id: string, payload: unknown) {
  publish(channel, id, payload);
}
