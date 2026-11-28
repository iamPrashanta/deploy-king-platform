# Local test environment

Everything needed to run Deploy King on your own machine and check it end to end lives in this folder.
One script on your computer drives it all: `env.ps1`.

These are not unit tests. Each check drives the real API, worker and panel and prints `PASS` / `FAIL` lines.
All passwords and secrets in here belong to the throwaway test database.

## Start here

From the repository root, in PowerShell (Podman must be running: `podman machine start`):

```powershell
powershell -ExecutionPolicy Bypass -File tests\local\env.ps1 up      # first time: builds the image, about 10 minutes
powershell -ExecutionPolicy Bypass -File tests\local\env.ps1 test    # run every check
```

| Command | What it does |
| --- | --- |
| `up` | Builds the image if it is missing, creates the containers, installs packages, makes a fresh database with the two test users, starts API, worker and panel. Run it again after the containers were removed. |
| `test` | Runs every check and saves the output in `/tmp/all.log` inside the container. `test capacity.mjs` runs one. |
| `status` | Which containers are up, and whether the API and panel answer. |
| `sync` | After changing API or worker code: copy the repository in, typecheck, restart. |
| `panel` | After changing panel code: copy, typecheck, rebuild, restart. |
| `migrate` | After changing the database schema: generate the next migration, apply it, copy the files back to `packages/db/drizzle`. |
| `sh` | A shell inside the container. |
| `down` | Stop and remove the containers. The image and the working copy are kept, so the next `up` is quick. |

Where things answer:

- Panel: http://localhost:3900 (`admin` / `Check-Passw0rd-12345`; a second, non-admin user is `bob` / `Bob-Passw0rd-12345`)
- API: http://localhost:4000
- Apps you deploy: `http://<name>.localhost:8088`

## What is in this folder

| Folder | Holds |
| --- | --- |
| `env.ps1` | The one entry point, run on your computer. |
| `env/` | The environment itself: the image (`Containerfile`), first-time setup (`setup.sh`), and the scripts `env.ps1` calls inside the container (sync, start, panel, reset, migrate, typecheck, fixtures, test users). |
| `checks/` | The checks, the shared helper `lib.mjs`, and `all.sh`, which runs them in order. |
| `tools/` | Helpers for looking at things by hand: screenshots, listing or deleting test apps, reading a deploy log. Not part of `test`. |

Inside the container the scripts from all three folders sit side by side in `/t`, so they can call each other as `/t/<name>`. `env/pull.sh` copies them there; every `env.ps1` command does that first.

## What it creates

Four containers on the network `dbbkp-check-net`, all named `dbbkp-check-*`:

| Container | Role |
| --- | --- |
| `dbbkp-check-app` | API (:4000), worker and panel (:3000). The repository is mounted read-only at `/src`; the working copy is the volume `dbbkp-check-work` at `/work`. |
| `dbbkp-check-pg` | PostgreSQL for the panel. |
| `dbbkp-check-redis` | Job queue. |
| `dbbkp-check-traefik` | The proxy in front of deployed apps. |

Apps deployed during a check are extra containers on the same network. The checks delete what they create.

## The checks

| Script | Covers |
| --- | --- |
| `fitunit.ts`, `capacity.mjs`, `fitui.mjs` | The capacity ledger and "will it fit?": the rules on fixed numbers, against the API, and in the panel |
| `teamunit.ts`, `teamflow.ts` | Team roles and extras on fixed inputs; then invitations, accepting, changing access, suspending, removing and sign-up requests through the API, in a database of their own |
| `accessflow.ts` | Who may reach what outside the apps pages: files, scheduled jobs, databases, backups, servers, pipelines, the audit log, and the closed registration route |
| `cleanunit.ts`, `cleanapi.ts` | Cleanup through the API (who may do what, the setting, the run record), and on fixed inputs: what may be removed, what needs a typed name, what an automatic run leaves alone, and when one is due |
| `installcheck.sh` | The installer on made-up servers: fresh, with a web server, with another control panel, too small, no terminal. Needs only bash: `bash tests/local/checks/installcheck.sh` |
| `dataflow.ts`, `datalocal.sh` | Data: databases (masked connection strings, connect by URL), backups with SHA-256, 3 attempts and every destination, schedules, keep rules, destinations, restores (new copy, replace, data only, safety backup, checksum refused), volume files (browse, edit, upload, ZIP download, path checks) and who may do each. Real `pg_dump`/`pg_restore`, so it needs `postgresql-client`; `datalocal.sh` runs it against any PostgreSQL you can reach as a superuser: `PG=postgres://postgres:postgres@127.0.0.1:5432 bash tests/local/checks/datalocal.sh dataflow.ts` |
| `securityflow.ts` | 2-step sign-in, invitation emails and alerts through the API's own router, with a fake mail transport and a fake fetch (nothing leaves the machine) |
| `freshdb.sh` | Not a check: runs one that needs an empty database (`teamflow.ts`, `accessflow.ts`, `cleanapi.ts`, `watchflow.ts`, `actflow.ts`, `jobsflow.ts`, `assistantflow.ts`, `sshflow.ts`, `desktopflow.ts`, `securityflow.ts`, `ticketflow.ts`, `dataflow.ts`) in a database of its own, then drops it |
| `hostscan_check.py` | The host scan (`scripts/host-scan.py`) on a made-up server: what it finds, and that no secret ends up in the report. Needs only Python: `python3 tests/local/checks/hostscan_check.py` |
| `hostact_check.py` | The action helper (`scripts/host-act.py`) on a made-up server, commands recorded instead of run: every action, its undo, and what it refuses. Needs only Python |
| `actflow.ts` | Remove and Undo end to end: finding, request, the real helper, result, undo |
| `watchunit.ts`, `watchflow.ts` | The server watch: what counts as new or changed and how urgent it is, on fixed inputs; then from report file to answered finding through the API |
| `scheduleunit.ts` | Cron text, schedules in words, next runs in different time zones |
| `jobsflow.ts` | Scheduled jobs and workers through the API (queues replaced by in-memory stand-ins): permissions, scheduling, pausing, run now, start-up sync, workers and the memory ledger, failed and skipped runs, Needs attention |
| `assistantflow.ts` | The assistant (`dk`, the desktop app) against the API: the MCP tools for scheduled jobs, workers and databases, `set_env` with `replaceAll`, the ZIP upload for agent tokens (`/mcp/upload`), and one whole `@dbbkp/assistant` conversation with a scripted model that deploys a folder. No AI is called. The assistant's own tests: `pnpm --filter @dbbkp/assistant test` and `pnpm --filter @dbbkp/cli test` (the `dk` bundle against a fake API and a fake Messages API on localhost) |
| `sshflow.ts`, `serversui.mjs` | Servers & SSH against a real SSH server in a container (`lscr.io/linuxserver/openssh-server`, needs docker or podman, skipped without one): admins only, key pairs stored encrypted, "Install it for me" with a one-time password, trust on first use, the connection test, a terminal over the WebSocket with password re-check, recording, replay and idle timeout, key rotation (and a failed one that changes nothing), a changed host key refused. `serversui.mjs` does the same through the panel's wizard and server page |
| `desktopflow.ts` | Deploy King Desktop's key (`DESKTOP_MODE=true`): the `Authorization: Desktop <key>` check, register closed, the local admin's session, the assistant token and its rotation, and the admin made at the first start (its first password is replaced and no change is asked for) |
| `ticketunit.ts`, `ticketflow.ts` | Tickets on a desktop machine with an account (`DESKTOP_MODE=true` and `DESKTOP_REQUIRE_TICKETS=true`). `ticketunit.ts` reads the API's own router, MCP tools and REST routes and fails when a mutation, a tool or a route is not in the ticket table (`packages/tickets/src/table.ts`); it needs no database: `cd apps/api && npx tsx ../../tests/local/checks/ticketunit.ts`. `ticketflow.ts` runs the API with a locally made signing key against an empty database and a real Redis: no ticket, a valid one (once), a second use, expired, wrong computer, wrong class, unknown key, changed fields, the keys file rewritten while running, ZIP uploads whose bytes do and do not match the ticket (the panel's upload and the assistant's), MCP tools, terminals over the WebSocket, the audit log, what needs no ticket (queries, sign-in), and both settings off. Outside the check container: `PG=postgres://... REDIS_URL=redis://127.0.0.1:6379 bash tests/local/checks/datalocal.sh ticketflow.ts`. The ticket format and the rules on fixed inputs, with the control server's test vectors: `pnpm --filter @dbbkp/tickets test` |
| `crashloop.mjs` | Crash-loop watcher, Overview "Needs attention", the "keeps crashing" trigger |
| `rootdir.mjs`, `rootui.mjs` | Root directory (monorepos) and build-time variables, API and browser |
| `wf.mjs`, `wf2.mjs` | Workflow editor in the browser; webhook, deploy and deploy-step triggers |
| `wf3.mjs` | Workflows may not call private addresses unless the owner is an admin |
| `mcp.mjs`, `mcp2.mjs`, `agents.mjs` | MCP server, token access levels, the AI agents page |
| `t1.mjs` … `t8.mjs`, `flow.mjs` | Deploy engine, project check, mid-deploy questions. Older and slower; not in `all.sh`. |

## Good to know

- On Windows, Podman's Linux machine can shut down when nothing is attached to it. `test` stays attached for that reason; avoid starting long runs in the background.
- `tools/landing-shots.mjs` screenshots the landing page, which is the separate `deploy-king` project: copy that project into the container, build it, serve it on :3100, then run the script.
- `tools/logopt.mjs` shows what the container engine accepts for log limits.
