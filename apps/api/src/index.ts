import "./env";
import express from "express";
import cors from "cors";
import http from "http";
import morgan from "morgan";
import getPort from "get-port";
import { INTERNAL_SECRET, safeEqual } from "./config";
import { requireAuth, requireAdmin } from "./middleware/requireAuth";

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./trpc";
import { createContext } from "./trpc/trpc";

import { broadcastLog, setupWebSocketGateway } from "./ws/gateway";

// REST routes
import authRouter from "./routes/auth";
import sitesRouter from "./routes/sites";
import backupRouterLegacy from "./routes/backup";
import infraRouterLegacy from "./routes/infra";
import webhooksRouter from "./routes/webhooks";
import hooksRouter from "./routes/hooks";
import mcpRouter from "./routes/mcp";
import { llmsTxt } from "./routes/llms";
import { syncAllSchedules } from "./services/automations";
import securityRouter from "./routes/security";
import nodesRouter, { sweepOfflineNodes, pruneOldMetrics } from "./routes/nodes";
import { startExpirationReaper } from "./services/reaper";
import { startAutomaticCleanup } from "./services/cleanup";
import { startHostWatch } from "./services/hostwatch";
import { syncSchedules } from "./services/cronjobs";
import { startReconciliationLoop } from "./services/reconciler";
import { runMigrations, ensureFirstAdmin, db } from "@dbbkp/db";
import { sql } from "drizzle-orm";

const app = express();

// ─── Middleware ─────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
// Keep the raw bytes: webhook signatures are computed over the exact payload GitHub sent,
// and re-serialising the parsed JSON never reproduces it.
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));
app.use(morgan("dev", {
  skip: (req) => req.url === "/internal/log"
}));

// ─── REST Auth (legacy support) ─────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/sites", requireAuth, sitesRouter);
app.use("/webhooks", webhooksRouter);
app.use("/hooks", hooksRouter);
app.use("/mcp", mcpRouter); // AI agents (Model Context Protocol)
app.get("/llms.txt", llmsTxt); // how agents use this server
app.use("/internal/security", securityRouter);
app.use("/internal/nodes", nodesRouter);

// ─── tRPC ──────────────────────────────────────────────────
app.use(
  "/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
    onError: ({ error, path }) => {
      console.error(`[tRPC ERROR] ${path}:`, error);
    },
  })
);

// ─── Legacy REST (for old Vite UI) ──────────────────────────
// These enqueue host-level jobs (and backup jobs carry DB credentials), so admin only.
app.use("/api/backup", requireAuth, requireAdmin, backupRouterLegacy);
app.use("/api/infra", requireAuth, requireAdmin, infraRouterLegacy);

// ─── Health ────────────────────────────────────────────────
// Used by the container health check and the installer. 503 while the database does not answer.
app.get("/health", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ status: "ok", ts: Date.now() });
  } catch {
    res.status(503).json({ status: "error", error: "database unavailable", ts: Date.now() });
  }
});

app.post("/internal/log", (req, res) => {
  if (!safeEqual(req.headers["x-internal-key"], INTERNAL_SECRET)) {
    console.warn(`[Security] Unauthorized attempt to /internal/log from ${req.ip}`);
    res.status(403).json({ error: "Forbidden: Invalid internal key" });
    return;
  }

  const { jobId, message, type } = req.body ?? {};
  if (!jobId || typeof message !== "string") {
    res.status(400).json({ error: "jobId and message are required" });
    return;
  }

  broadcastLog(String(jobId), message, type === "error" || type === "done" ? type : "log");
  res.json({ ok: true });
});

// ─── Error Handling ────────────────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Express Error]:", err);
  res.status(500).json({ 
    error: "Internal Server Error", 
    message: err.message || "An unexpected error occurred" 
  });
});

// ─── HTTP + WS Server ──────────────────────────────────────
async function startServer() {
  // A new install or an update needs no manual step: apply migrations, then create the
  // first admin from INITIAL_ADMIN_PASSWORD if there is no user yet. DB_AUTO_MIGRATE=false turns this off.
  if (process.env.DB_AUTO_MIGRATE !== "false") {
    console.log("[DB] Applying migrations...");
    await runMigrations();
    console.log("[DB] Migrations are up to date");
    await ensureFirstAdmin();
  }

  // Re-register workflow schedules on boot (BullMQ keeps them, this repairs drift).
  syncAllSchedules()
    .then((n) => console.log(`[Workflows] ${n} workflow schedules checked`))
    .catch((err) => console.error("[Workflows] Could not sync schedules:", err.message));

  const DEFAULT_PORT = Number(process.env.API_PORT ?? 4000);
  
  // Use a fixed port to keep frontend alignment
  const port = await getPort({ 
    port: [DEFAULT_PORT] 
  });

  const httpServer = http.createServer(app);

  // Attach unified WebSocket gateway
  setupWebSocketGateway(httpServer);

  httpServer.listen(port, "0.0.0.0", () => {
    console.log("\n═══════════════════════════════════════");
    console.log(`[API] Server Ready`);
    console.log(`[API] URL: http://localhost:${port}`);
    console.log(`[API] tRPC: http://localhost:${port}/trpc`);
    console.log(`[API] WS Logs: ws://localhost:${port}/ws/logs`);
    if (port !== DEFAULT_PORT) {
      console.warn(`[API] Warning: Port ${DEFAULT_PORT} was busy. Fallback to ${port}.`);
    }
    console.log("═══════════════════════════════════════\n");

    // ─── Background sweeps ────────────────────────────────────────────────────
    // Offline detection: marks nodes offline if heartbeat > 60s stale
    setInterval(async () => {
      try { await sweepOfflineNodes(); } catch {}
    }, 30_000);

    // Metrics retention: prune node_metrics older than 7 days
    pruneOldMetrics().catch(() => {});
    setInterval(async () => {
      try { await pruneOldMetrics(); } catch {}
    }, 24 * 60 * 60 * 1000);

    // Expiration reaper: cleanup temporary sites/previews every 10m
    startExpirationReaper();
    startAutomaticCleanup();
    startHostWatch();
    syncSchedules().then((r) => console.log(`[Cron] ${r.jobs} scheduled jobs, ${r.added} schedules restored`)).catch((e) => console.error("[Cron] could not sync schedules:", e?.message ?? e));

    // Reconciliation loop: fix drift/crashed containers every 15m
    startReconciliationLoop();
  });

  httpServer.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[API] Error: Port ${port} is already in use.`);
      process.exit(1);
    } else {
      console.error("[API] Server error:", err);
    }
  });
}

startServer().catch((err) => {
  console.error("[API] Failed to start server:", err);
  process.exit(1);
});
