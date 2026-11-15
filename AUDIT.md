# DBBKP Platform — Code Audit

**Date:** 2026-09-13
**Scope:** full repo (`apps/*`, `packages/*`, `scripts/`, compose + Dockerfiles)
**Codebase size:** ~6,300 lines TS across 4 apps and 11 packages, plus a Go agent and ~2,000 lines of bash.
**Method:** static read of every source file. Nothing was executed — the environment has no pnpm/Docker/network, so nothing below is "the build says"; every finding cites a file and line you can check yourself.

---

## Verdict in one paragraph

The architecture is genuinely ambitious and mostly sound on paper: control plane / worker split, BullMQ queues, an execution broker, a Go telemetry agent, Traefik-based routing, RBAC, AES-GCM secret encryption. But the repository in its current state **cannot start**. There are hard `ReferenceError`/`TypeError`-class defects on the two most important code paths (the deploy worker and the pipeline worker), a database schema that is missing a column the ownership model depends on, no migrations directory, no lockfile, and a production compose file that references a Dockerfile that does not exist. The README describes a finished product; the code is roughly a strong 40% skeleton. The good news: almost everything in the "Blockers" list is a small, mechanical fix. The real work is in tier 2 and 3.

---

## Tier 0 — Blockers (the platform cannot run today)

### B1. `sites` table has no `userId` column, but nine code sites use it
`packages/db/src/schema.ts:92-130` defines `sites` with no owner column. Yet:
- `apps/api/src/trpc/routers/sites.router.ts:55,147,165,213,252` filter on `sites.userId`
- `apps/api/src/ws/gateway.ts:103` joins on `sites.userId`
- `apps/worker/src/hosting.worker.ts:248,250,298,300` read `site.userId`

Effect: TypeScript will not compile, and at runtime every non-admin `sites.list/get/delete/stats/rollback` and all container ownership validation fails. **The entire multi-tenant ownership story is unimplemented at the data layer.**

### B2. `pipeline.worker.ts` never destructures its job data
`apps/worker/src/pipeline.worker.ts:212-300` uses `runId`, `dbJobId`, `repoUrl`, `branch`, `buildCommand`, `deployCommand`, `envVars` — none are ever declared. The `const { ... } = job.data` line is simply absent. `execa` is also used at lines 231 and 311 but never imported. Every pipeline run dies with `ReferenceError` before it does anything. CI/CD is 100% non-functional.

### B3. `db._.eq(...)` is not a real API — 7 occurrences
`apps/api/src/ws/gateway.ts:94, 103, 187, 307, 360`. `db._` is Drizzle's internal metadata object; it has no `eq`/`and`. Every call throws `TypeError: db._.eq is not a function`. This kills container-ownership validation, terminal open/input, session close, and the session reaper. Fix: import `eq, and` from `drizzle-orm` like every other file does.

### B4. Docker-type and PHP-type sites are built but never started
In `apps/worker/src/hosting.worker.ts`, the runtime-container block (lines ~200-305, "4. Runtime Stage") is nested **inside** the `else if (type !== "static" && type !== "php")` branch that begins at line ~170. So for `type === "docker"` the image is built and then nothing runs it, and `type === "php"` never creates a container at all — despite both branches containing dedicated `type === "php"` / `type === "docker"` logic that is therefore dead. The block needs to be de-nested one level.

### B5. `docker docker build ...`
`apps/worker/src/hosting.worker.ts:128-131`: `buildCmd = ["docker","build","-t",...]` then `execa("docker", buildCmd, ...)` — the binary name is passed again as the first argument. Every Docker-type build fails immediately.

### B6. Three different JWT secret defaults
- `apps/api/src/trpc/trpc.ts:8` → `"dev-secret"`
- `apps/api/src/trpc/routers/auth.router.ts:10` → `"dbbkp-super-secret-change-in-prod"`
- `apps/api/src/ws/gateway.ts:38` → `"dbbkp-super-secret-change-in-prod"`

With `JWT_SECRET` unset (the default dev experience, and also the default in `docker-compose.prod.yml`, which never passes `JWT_SECRET`), login succeeds and then **every authenticated tRPC call returns 401**. Should be one shared module that throws on a missing secret in production.

### B7. No migrations, no lockfile, no panel Dockerfile
- `packages/db/drizzle/` does not exist → the documented `pnpm db:migrate` has nothing to apply.
- `pnpm-lock.yaml` is absent, but `apps/api/Dockerfile:10` and `apps/worker/Dockerfile:8` both `COPY pnpm-lock.yaml` and run `--frozen-lockfile` → image build fails on the COPY.
- `docker-compose.prod.yml` builds `./apps/panel/Dockerfile`, which does not exist → `docker compose up` fails.

### B8. Dockerfiles install production deps then try to run TypeScript
`apps/api/Dockerfile:14,22` — `pnpm install --prod` (drops `tsx`/`typescript`), then `CMD ["node","--loader","ts-node/esm", ...]` with `ts-node` nowhere in any `package.json`. Same in `apps/worker/Dockerfile`. Neither image can start. Either build to JS (`tsc`) or ship `tsx` and run `tsx src/index.ts`.

### B9. Five packages are not in the workspace
`packages/{kernel,intelligence,intelligence-gateway,intelligence-memory,infra-graph}` have **no `package.json`**, so pnpm never links them. `packages/intelligence-gateway/src/index.ts:1` imports `@dbbkp/intelligence` — unresolvable. Separately, `@dbbkp/utils` *is* imported by `packages/runner/src/broker.ts:3`, `apps/api/src/services/security-reconciler.ts` and others, but is not declared as a dependency in any consuming `package.json`, so strict pnpm linking will not resolve it either.

---

## Tier 1 — Security defects

### S1. GitHub webhook signature verification can never pass
`apps/api/src/routes/webhooks.ts:10-16,30`. The HMAC is computed over `JSON.stringify(req.body)` — a re-serialization of the parsed body, not GitHub's raw bytes. Key order, whitespace and unicode escaping will differ, so the digest never matches. You need `express.json({ verify: (req,_res,buf) => { req.rawBody = buf } })` and HMAC over `req.rawBody`.
Two further problems on the same path:
- `crypto.timingSafeEqual` **throws** when buffers differ in length (a malformed header is a 500, not a 401).
- If `GITHUB_WEBHOOK_SECRET` is unset the check is skipped entirely (`if (secret)`), so anyone who knows a repo URL can trigger deploys. Signature verification must be mandatory.

### S2. WebSocket subscriptions are unauthorized
`apps/api/src/ws/gateway.ts` (`type === "subscribe"` handler). The `subscribe` handler accepts any `channel`/`id` from any authenticated user with no ownership check, and `channel: "containers"` immediately starts streaming Docker logs for the supplied container ID. Any logged-in user — including a `viewer` — can read the logs of **any container on the host**, including `dbbkp-postgres`. Ownership is only checked on `terminal.open` (line 268). Same gap for `logs:<jobId>` and `metrics:<nodeId>`.

### S3. Agent↔API auth is one static shared secret with no identity binding
`apps/api/src/routes/security.ts:13-23` and `apps/api/src/index.ts:60-70`. Any holder of `INTERNAL_SECRET` can post telemetry, posture and FIM data for **any** `nodeId`/`siteId` — there is no per-node credential, no nonce, no replay protection. The comparison is also plain `!==` (not constant-time), and both places fall back to the hardcoded default `"dbbkp-internal-secret-change-me"` when the env var is missing, so a misconfigured deployment is silently wide open. Per-node tokens (or mTLS) plus `crypto.timingSafeEqual` is the fix.

### S4. The Execution Broker's guarantees are mostly theatre
`packages/runner/src/broker.ts`:
- Blocked-pattern matching is naive substring matching (line 85). `rm -rf /` is blocked; `rm -rf /var/www` is not, and neither is `rm  -rf /` (double space), `sh -c 'rm -rf /'`, or anything base64-encoded.
- The tenant/ownership check at line 73 is an empty `if` with a commented-out body — labelled "Conceptual". So "no infrastructure mutation is trusted implicitly" is not true today.
- `runShell` (line 118) passes the full `process.env` into the child, including `MASTER_KEY`, `DATABASE_URL` and `JWT_SECRET`.
- `getDockerSecurityArgs` is never called by the hosting worker, which hand-rolls its own `HostConfig` instead.

### S5. `docRoot` and `domain` are never validated
`apps/api/src/trpc/routers/sites.router.ts:73` accepts `domain: z.string()` with no pattern. That value flows into a Traefik `Host()` rule and into file paths (`/opt/dbbkp/traefik/rules/${site.domain}.yml`, `hosting.worker.ts:36,~330`). `docRoot` from the DB is passed to `fs.emptyDir()` (`hosting.worker.ts:~100`) with no prefix check — a bad row means recursive deletion of an arbitrary directory. Validate the domain with a hostname regex, and assert `docRoot.startsWith("/var/www/sites/")` before any destructive call.

### S6. Dev compose exposes unauthenticated data stores on all interfaces
`docker-compose.yml` publishes Postgres on `5432` with `postgres/postgrespassword`, Redis on `6379` with **no password**, and redis-commander on `8081` with no auth. On a machine with a public IP that is immediate full compromise. Bind to `127.0.0.1:` at minimum.

### S7. Password change does not invalidate the current token properly
`auth.router.ts:changePassword` deletes all DB sessions (good), but the JWT itself remains cryptographically valid for its 7-day `expiresIn`. Protected procedures do re-check the session row (`trpc.ts:63-75`), so this is mitigated — but `gateway.ts:authenticateToken` (line 80) does **not** check the session table, so a revoked token still opens WebSockets and terminals until expiry.

### S8. Secrets are global, not scoped
`packages/db/src/schema.ts:164` — `secrets.keyName` is globally unique with no `siteId`/`userId`/tenant column. Two tenants cannot both have a `DATABASE_URL`. The encryption itself (`packages/security/src/encryption.ts`) is correct AES-256-GCM with a random IV and enforced 32-byte key — that part is well done.

---

## Tier 2 — Runtime / deployment correctness

### R1. Traefik file provider is never enabled
`docker-compose.prod.yml` mounts `/opt/dbbkp/traefik/rules` into the container but the `command:` block has no `--providers.file.directory=/etc/traefik/rules --providers.file.watch=true`. The hosting worker writes routing YAML there for every node/python/docker site (`hosting.worker.ts:~330`). **Traefik never reads it.** Non-static sites get no routing and no certificate.

### R2. Those routing files point at `127.0.0.1` anyway
The generated service URL is `http://127.0.0.1:${port}`. Inside the Traefik container that is Traefik itself. It must be the host gateway (`host.docker.internal` / `172.17.0.1`) or, better, the container name on a shared Docker network.

### R3. Site containers are not on Traefik's network
The static-site path (`hosting.worker.ts:~270`) creates an `nginx:alpine` container with correct Traefik labels but never attaches it to the `dbbkp` network. Traefik's Docker provider only routes to containers it shares a network with, so the labels are ignored. Every site container needs `NetworkingConfig` joining the platform network.

### R4. Workers connect to Redis at `127.0.0.1` in production
`apps/worker/src/connection.ts` and `apps/api/src/queues.ts` read `REDIS_HOST`/`REDIS_PORT`, but `docker-compose.prod.yml` only supplies `REDIS_URL`. Inside the container `127.0.0.1:6379` is nothing. Also neither reads a Redis password, while the prod Redis runs `--requirepass`. Queues will never connect in production.

### R5. `packages/db` never loads `.env`
`apps/api/src/env.ts` hand-rolls a `.env` walker, but `packages/db/src/index.ts` and `drizzle.config.ts` read `process.env.DATABASE_URL` directly with a `postgres:postgres@localhost` fallback. Running `pnpm db:migrate` / `db:seed` from the package directory silently targets the wrong database. Use `dotenv` once, at the top of every entrypoint.

### R6. Traefik router rule is invalid syntax
`docker-compose.prod.yml`: ``PathPrefix(`/api`, `/trpc`, `/webhooks`, `/internal`)``. Traefik v3 matchers take a single argument; this needs `||`-joined matchers. The router will fail to load, taking the API off the reverse proxy.

### R7. `updatedAt` written to a table that has no such column
`hosting.worker.ts:~255` — `onConflictDoUpdate({ set: { siteId, updatedAt: new Date() } as any })` against `container_instances`, which has no `updated_at` (`schema.ts:332-341`). The `as any` hides it from the compiler; Postgres will reject it at runtime. The reaper in `gateway.ts:253` reads `terminalSessions.updatedAt` — check that table too.

### R8. Traefik dashboard exposed
`--api.insecure=true` in the production compose publishes the dashboard. Port `8443` is mapped with no entrypoint listening on it.

### R9. Rollback is not actually durable
`hosting.worker.ts` tags images `dbbkp-site-<id>:<sha>`, but nothing prunes or records them, and `sites.currentTag` is only written on the non-static path. There is no deployments table, so the UI has no list of commits to roll back *to* — `sites.rollback` requires the user to type a SHA from memory.

### R10. Everything is single-node
`nodes` and `nodeMetrics` exist in the schema and the Go agent reports to them, but the hosting worker talks to a local `new Docker()` socket only. There is no node selection, no remote execution, no scheduling. The README's "distributed control plane" and "multi-cluster federation" are not present in any form.

### R11. Repository hygiene
- `apps/panel/.next/` is committed (65 tracked files). Add `.next/` to `.gitignore` and `git rm -r --cached`.
- Compiled `.js` twins of TSX components are committed (`PipelineForm.js`, `PipelineTimeline.js`, `TerminalLogViewer.js`) — Next will resolve these ahead of the `.tsx` in some setups, so you may be shipping stale UI.
- Every file is CRLF, so `git status` shows the whole tree as modified and real diffs are invisible. Add a `.gitattributes` with `* text=auto eol=lf` and renormalize.
- `apps/web` (Vite) is a dead stub — `App.tsx` alongside the real Next.js `apps/panel`. Delete it or document it.
- `turbo.json` uses the v1 `"pipeline"` key; Turbo v2 renamed it to `"tasks"`.

---

## Tier 3 — Gap analysis vs Dokploy / Coolify

Rated against the four areas you picked.

### Git deploys + automatic builds — ~25%
| Capability | Status |
| --- | --- |
| GitHub push webhook | Endpoint exists, signature verification broken (S1) |
| Auto-deploy on push | Wired for sites; **pipelines are a `console.log` stub** (`webhooks.ts:54-56`) |
| PR preview environments | Creation path exists; teardown only flips `active=false`, containers and DNS leak (`webhooks.ts:129`) |
| GitLab / Bitbucket / Gitea | Absent |
| Private repo auth (deploy keys, PATs) | **Absent** — `git clone` with no credentials, so private repos cannot deploy at all |
| Nixpacks / Buildpacks auto-detection | Absent. Build detection is three `if` statements on lockfile presence |
| Dockerfile build | Present but broken (B4, B5) |
| docker-compose app support | Absent |
| Build cache | Absent (`--depth=1` clone + fresh install every deploy) |
| Deployment history / rollback UI | No deployments table; rollback takes a raw SHA (R9) |

### Domains, TLS, routing — ~30%
Traefik is the right choice and ACME is configured, but R1/R2/R3 mean **routing does not currently work for any site type**. Also missing: multiple domains per app, www redirects, wildcard/DNS-01 certificates, per-app custom Traefik middleware, HTTP→HTTPS redirect middleware, basic-auth protection, a "check DNS points here" preflight. Cloudflare DNS auto-provisioning exists (`services/cloudflare.ts`) and is a nice touch.

### Databases + backups — ~20%
`db_instances` is four columns (`type`, `name`, `dbUser`, `siteId`) — no password, no port, no container ID, no version, no volume. There is a `database.worker.ts` and a `backup.service.ts`, plus solid-looking bash (`scripts/dbbkp.sh`, 831 lines). Missing: one-click provisioning for MySQL/MongoDB/MariaDB, connection strings surfaced in the UI, scheduled backups to S3/B2, restore-from-backup, retention policies, per-database resource limits. Backups today are host-level bash, not per-tenant database objects.

### Logs, metrics, terminal — ~45%
The strongest area. Real xterm.js + node-pty terminal, real Docker log streaming, `recharts` metrics, a Go agent collecting process/FIM/network telemetry, PTY session recording. Blocked by B3 (nothing in the gateway runs) and S2 (no authorization). Missing: historical/searchable logs (streams are ephemeral, `tail: 200`), log download, per-app metric retention and alerting, container resource graphs over time, crash/exit notifications.

### Present in DBBKP and *not* in Dokploy
Worth protecting — this is the actual differentiator: the EDR/FIM/posture agent, policy packs with monitor/guided/enforce/locked modes, the remediation plan→approve→execute→verify lifecycle, PTY session recording for audit, AES-GCM secret vault, and desired-state reconciliation. **None of it is finished, but the concept is the reason to build this instead of installing Dokploy.**

### Missing platform basics that both have
No tests of any kind (0 test files in the repo). No CI. No structured logging (`console.log` throughout). No error tracking. No health/readiness endpoints beyond a static `/health`. No API rate limiting. No user invite/team management UI. Panel has only 6 pages (login, password setup, dashboard, sites list/create/detail) against 12 tRPC routers — databases, backups, pipelines, cron, nodes, security and audit have **no UI at all**.

---

## Recommended sequence

**Phase 1 — make it run (est. 1-2 days).** Fix B1-B9. Add `userId` to `sites`, generate the first migration, commit a lockfile, one shared `auth/jwt.ts`, de-nest the runtime block, fix the `execa` call, replace `db._`, register the orphan packages (or delete the four that are dead), write a panel Dockerfile, switch images to `tsx` or a real `tsc` build. Exit criterion: `pnpm install && pnpm db:migrate && pnpm dev` boots, you can log in, create a static site and see it served over HTTP.

**Phase 2 — make it safe (2-3 days).** S1-S8 plus R1-R4, R6-R8. Raw-body webhook HMAC, authorize WS subscriptions, per-node agent tokens, domain/path validation, bind dev services to localhost, enable the Traefik file provider and put site containers on the platform network, feed Redis credentials from `REDIS_URL`. Exit criterion: a git-push deploy reaches a real HTTPS URL with a valid certificate, and a `viewer` account can't read another tenant's logs.

**Phase 3 — close the PaaS gap (2-4 weeks).** In value order: (1) a `deployments` table with per-deploy status/logs/image tag, giving you real history and one-click rollback; (2) per-app environment variables (new table, encrypted with the existing vault, injected at container create); (3) private-repo deploy keys; (4) Nixpacks integration — it is one binary and it removes almost all of your hand-written build detection; (5) real database provisioning with credentials + scheduled S3 backups; (6) persisted searchable logs; (7) panel pages for the seven routers with no UI.

**Phase 4 — the differentiator.** Finish the security plane (real broker enforcement, working reconciler, remediation approval UI) and only then look at multi-node. Multi-node is a much bigger change than it appears — it means every `new Docker()` becomes a remote call through the agent.

**Running throughout:** `.gitattributes` + line-ending renormalize on day one (otherwise no diff is reviewable), untrack `.next/`, delete the committed `.js` twins, and add a test for at least the deploy worker and the auth middleware before Phase 3 refactors them.

---

## Honest note on the README

`README.md` currently claims multi-cluster federation, global load balancing, hosted control plane, AI SRE auto-healing and MCP tool serving. `packages/intelligence/src/index.ts:48` returns a mock response; there is no federation code. If anyone evaluates this repo against its README they will lose trust fast. Recommend splitting it into "Implemented" / "In progress" / "Roadmap" — the honest implemented list is still a respectable project.
