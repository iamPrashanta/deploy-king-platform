import { router } from "./trpc";

import { authRouter } from "./routers/auth.router";
import { backupRouter } from "./routers/backup.router";
import { infraRouter } from "./routers/infra.router";
import { sitesRouter } from "./routers/sites.router";
import { databaseRouter } from "./routers/database.router";
import { cronRouter } from "./routers/cron.router";
import { workersRouter } from "./routers/workers.router";
import { filesRouter } from "./routers/files.router";
import { auditRouter, secretsRouter } from "./routers/audit.router";
import { nodesRouter } from "./routers/nodes.router";
import { securityRouter } from "./routers/security.router";
import { pipelineRouter } from "./routers/pipeline.router";
import { gitRouter } from "./routers/git.router";
import { systemRouter } from "./routers/system.router";
import { automationsRouter } from "./routers/automations.router";
import { mcpRouter } from "./routers/mcp.router";
import { teamRouter } from "./routers/team.router";
import { hostRouter } from "./routers/host.router";
import { serversRouter } from "./routers/servers.router";
import { twoFactorRouter } from "./routers/twofactor.router";
import { notifyRouter } from "./routers/notify.router";

export const appRouter = router({
  auth: authRouter,
  backup: backupRouter,
  infra: infraRouter,
  pipeline: pipelineRouter,
  sites: sitesRouter,
  database: databaseRouter,
  cron: cronRouter,
  workers: workersRouter,
  files: filesRouter,
  audit: auditRouter,
  secrets: secretsRouter,
  nodes: nodesRouter,
  security: securityRouter,
  git: gitRouter,
  system: systemRouter,
  automations: automationsRouter,
  mcp: mcpRouter,
  team: teamRouter,
  host: hostRouter,
  servers: serversRouter,
  twoFactor: twoFactorRouter,
  notify: notifyRouter,
});

export type AppRouter = typeof appRouter;
