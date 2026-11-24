# Deploy King

A self-hosted platform for deploying and running apps on your own server, in the spirit of Coolify and Dokploy, with n8n-style workflows, built-in security monitoring and an MCP server for AI agents.

You point it at a GitHub repository, a ZIP file or a Docker image. It works out how to build the app, runs it in a container behind HTTPS, and keeps it running. On the way it checks that the app fits on the server, asks you when it needs a decision instead of failing, and watches the server for anything that should not be there.

> **Status (November 2026).** Everything below works in development and is covered by the checks in `tests/local`. Installing on a server with one command **is not finished yet**: see [Install on a server](#install-on-a-server) for what works today and what is missing.

---

## Contents

1. [What it does](#what-it-does)
2. [Requirements](#requirements)
3. [Run it on your own computer](#run-it-on-your-own-computer) (Docker or Podman)
4. [The local test environment](#the-local-test-environment)
5. [Install on a server](#install-on-a-server)
6. [Configuration](#configuration)
7. [Everyday operations](#everyday-operations)
8. [Project layout](#project-layout)
9. [Troubleshooting](#troubleshooting)
10. [License](#license)

---

## What it does

**Deploying**
- Deploy from GitHub (including private repositories), a ZIP upload, or any Docker image. One-click templates for common apps.
- A project check before building: it detects the language and version, and writes a Dockerfile when the repository has none. Monorepos (a root directory) and build-time variables are supported.
- Questions in the middle of a deploy instead of a failure: "your app listens on 8080, use that?", "it ran out of memory, retry with 1 GB?"
- Switch-over without downtime. Roll back to any of the last 5 builds with one click, without rebuilding.
- Deploy on every push, preview environments for pull requests, automatic HTTPS (Let's Encrypt).
- Build logs while it builds, app logs, a terminal inside the app. Variables are stored encrypted.
- **Workers:** extra background processes per app, such as a queue worker, with copies and memory limits.
- **Scheduled jobs:** commands that run inside an app on a schedule. Each has a time zone, a time limit, a run history with output, and an alert when it fails.

**Keeping apps up**
- Crash loops are detected and shown in "Needs attention", with the reason. An app that should be running and is not is started again.
- **Will it fit?** Before every deploy the panel checks the server's memory and disk, and blocks a deploy that would make the server run out. The owner can still choose "deploy anyway".
- Usage per app (memory, CPU, image and storage size). Cleanup of old images and build cache with one button, and automatically every week or when the disk passes 85%.

**Security**
- **Server watch.** The panel learns what is normal on the server and flags anything new or changed:
  - users, admin rights, SSH keys and settings
  - cron jobs, services, startup files, open ports
  - running coin miners, programs started from `/tmp`, connections to mining pools
  - containers with too much access
- Every finding has a level (Urgent, Check, Note), one sentence on why it matters, and a **Remove** button. A copy is kept first, so it can be undone for 30 days.
- Roles and permissions are enforced on every API call, and every action is in the audit log.

**Team**
- Invite people with a role (Admin, Developer, Viewer), access to all apps or only chosen ones, and optional extras.
- A "request access" page whose requests an admin approves. Members can be suspended or removed.

**Automation and AI**
- Visual workflows. Triggers: a schedule, a webhook, a deploy, "app keeps crashing". Steps: deploy, roll back, check, send a message.
- An MCP server, so AI agents (Claude, Cursor, Codex and others) can deploy, read logs and check capacity, with tokens that limit what they may do.

---

## Requirements

| For | You need |
| --- | --- |
| Development | Node.js 20 or newer, pnpm 9 (`corepack enable`), Git, and Docker **or** Podman. Linux, macOS, or Windows with WSL 2. |
| The checks that need no containers | Python 3 and bash |
| A server | Ubuntu 22.04/24.04 or Debian 12, root access, 2 GB of memory or more (1 GB minimum), 10 GB of free disk or more (5 GB minimum) |

---

## Run it on your own computer

The panel, the API and the worker run on your computer with `pnpm`. PostgreSQL, Redis, the Traefik proxy and the apps you deploy run as containers.

### With Docker

**1. Install packages**

```bash
git clone https://github.com/iamPrashanta/deploy-king-platform.git deploy-king
cd deploy-king
corepack enable
pnpm install
```

**2. Start PostgreSQL and Redis**

```bash
docker compose up -d dbbkp-postgres dbbkp-redis
```

They listen on `127.0.0.1` only. The database user is `postgres`, its password `postgrespassword`.

**3. Create `.env`**

```bash
cp .env.example .env
```

Then change these lines:

```dotenv
DATABASE_URL=postgres://postgres:postgrespassword@localhost:5432/dbbkp_panel
# make these with: openssl rand -base64 48
JWT_SECRET=paste-a-long-random-string-here
INTERNAL_SECRET=paste-another-long-random-string-here
# 64 hex characters, from: openssl rand -hex 32 (encrypts stored variables)
MASTER_KEY=paste-64-hex-characters-here
# an absolute path you can write to
SITES_ROOT=/home/you/deploy-king/data/sites
# plain HTTP on your computer; apps get <name>.localhost on port 8088
DBBKP_TLS=false
DBBKP_BASE_DOMAIN=localhost
DBBKP_PUBLIC_HTTP_PORT=8088
```

Keep comments on their own lines: a comment after a value on the same line becomes part of the value.

Create the folder: `mkdir -p data/sites`.

**4. Start Traefik**

Traefik sends `<name>.localhost:8088` to the right app container.

```bash
docker network create dbbkp
docker run -d --name dbbkp-traefik --network dbbkp -p 8088:80 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  traefik:v3.1 \
  --providers.docker=true --providers.docker.exposedbydefault=false \
  --providers.docker.network=dbbkp --entrypoints.web.address=:80
```

**5. Create the database and the first admin**

```bash
set -a; . ./.env; set +a      # these two commands read DATABASE_URL from the shell, not from .env
pnpm db:migrate
INITIAL_ADMIN_PASSWORD='choose-a-password' pnpm db:seed
```

Without `INITIAL_ADMIN_PASSWORD`, the seed makes up a password and prints it once. The user name is `admin`. You are asked to change the password at the first sign-in.

**6. Start the panel, the API and the worker**

```bash
pnpm turbo run dev --filter=@dbbkp/api --filter=@dbbkp/worker --filter=@dbbkp/panel
```

`pnpm dev` also works, but it starts `apps/web` as well, an older interface that is no longer used.

**7. Use it**

| What | Where |
| --- | --- |
| Panel | http://localhost:3000 |
| API | http://localhost:4000 (the panel forwards `/trpc`, `/api`, `/mcp` and `/hooks` to it) |
| Apps you deploy | `http://<name>.localhost:8088` |
| Redis browser (optional) | `docker compose up -d dbbkp-redis-ui`, then http://localhost:8081 |

To try a deploy, create an app from a public repository or from the image `nginx:alpine`.

### With Podman

The steps are the same as with Docker. Two things differ.

**The engine's socket.** The API and the worker talk to the container engine through the Docker API, and Podman offers it on a socket.

On Linux (rootless):

```bash
systemctl --user enable --now podman.socket
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
```

On macOS or Windows:

```bash
podman machine start
export DOCKER_HOST=unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')
```

Set `DOCKER_HOST` in the shell where you run `pnpm`, or put it in `.env`.

**Compose and Traefik.**
- Use `podman compose up -d dbbkp-postgres dbbkp-redis`, or `podman-compose`.
- In the Traefik command, mount the Podman socket in place of `/var/run/docker.sock`. With SELinux, add `--security-opt label=disable`:

```bash
podman network create dbbkp
podman run -d --name dbbkp-traefik --network dbbkp -p 8088:80 --security-opt label=disable \
  -v /run/user/$(id -u)/podman/podman.sock:/var/run/docker.sock:ro \
  docker.io/library/traefik:v3.1 \
  --providers.docker=true --providers.docker.exposedbydefault=false \
  --providers.docker.network=dbbkp --entrypoints.web.address=:80
```

### On Windows

Run the steps above inside **WSL 2** (Ubuntu), with Docker Desktop's WSL integration or Podman. Some parts of the worker call Linux tools (`git`, `tar`, `du`), so running `pnpm` directly in PowerShell is not supported.

To test everything without setting anything up by hand, use the local test environment below.

---

## The local test environment

`tests/local` holds a complete environment in containers, and checks that drive the real API, worker and panel. It is built for **Podman on Windows** and driven from PowerShell:

```powershell
podman machine start
powershell -ExecutionPolicy Bypass -File tests\local\env.ps1 up      # first time: builds an image, about 10 minutes
powershell -ExecutionPolicy Bypass -File tests\local\env.ps1 test    # run every check
```

| Command | What it does |
| --- | --- |
| `up` | Creates PostgreSQL, Redis, Traefik and an app container. Installs packages, makes a fresh database with two test users, starts everything. |
| `test` | Runs every check. `test capacity.mjs` runs one. |
| `status` | Shows what is running. |
| `sync` | Copies the repository in after you change API or worker code, then typechecks and restarts. |
| `panel` | Rebuilds the panel after you change it. |
| `migrate` | Makes the next database migration and copies it back into `packages/db/drizzle`. |
| `sh` | Opens a shell inside the app container. |
| `down` | Removes the containers. The image and working copy stay, so the next `up` is quick. |

| What | Where |
| --- | --- |
| Panel | http://localhost:3900 (test users `admin` / `Check-Passw0rd-12345` and `bob` / `Bob-Passw0rd-12345`) |
| API | http://localhost:4000 |
| Deployed apps | `http://<name>.localhost:8088` |

Every check, and what it covers, is listed in [tests/local/README.md](tests/local/README.md).

**Checks that need no containers.** Run these on any Linux, macOS or WSL machine:

```bash
python3 tests/local/checks/hostscan_check.py   # the server scan, on a made-up server
python3 tests/local/checks/hostact_check.py    # Remove and Undo on the server, commands recorded instead of run
bash tests/local/checks/installcheck.sh        # the installer's checks, on made-up servers
```

**With Docker instead of Podman.** `env.ps1` uses Podman commands. With Docker, follow [Run it on your own computer](#run-it-on-your-own-computer) and run single checks with `node tests/local/checks/<name>.mjs`, which talk to the API at `http://localhost:4000`. Some checks assume the container names of the test environment.

---

## Install on a server

### Before you start

- **A domain.** Point it at the server's IP: `portal.example.com` for the panel, and a wildcard `*.example.com` so every app gets `<name>.example.com`.
- **A used server is fine.** The installer was written for servers that already run websites. It lists what is there, and changes nothing until you confirm.

### What the installer checks (`scripts/install.sh`)

- Who uses ports 80 and 443, which web servers are installed (even if stopped), which sites they serve, which databases already listen, which containers run.
- **Another control panel** (cPanel/WHM, Plesk, CyberPanel, aaPanel, DirectAdmin, HestiaCP, VestaCP, CloudPanel, Virtualmin, Coolify, Dokploy, CapRover): it stops, because two panels on one web server undo each other's work. `--force` installs side by side anyway.
- **A web server already on 80/443:** it installs **side by side**. Its own proxy uses other ports (8088/8444), and existing sites are untouched. It writes `nginx.conf` and `apache.conf` examples to `/opt/dbbkp/side-by-side/`. You copy one into your web server to send the Deploy King addresses on.
- **Low memory or disk:** it notes it, and stops below 1 GB of memory or 5 GB of free disk.
- It prints the plan and asks once before changing anything.

```bash
sudo bash scripts/install.sh --dry-run                       # show the plan, change nothing
sudo bash scripts/install.sh --domain example.com            # install
sudo bash scripts/install.sh --domain example.com --yes      # without the question (scripts, CI)
sudo bash scripts/install.sh --force                         # next to another control panel
sudo bash scripts/install.sh --mode existing-panel           # side by side even on a free server
```

It also installs the **server watch** (`scripts/install-scan.sh`): a read-only scan every five minutes, and the helper behind Remove and Undo on the Security page.

### What is missing for a one-command install

The installer starts the platform from prebuilt images (`ghcr.io/dbbkp/api`, `worker`, `panel`, `agent`). **Those images are not published yet**, so the final `docker compose up` step fails. Three more gaps:

- `apps/panel` has no Dockerfile, so `docker-compose.prod.yml` cannot build the panel either.
- `apps/api/Dockerfile` and `apps/worker/Dockerfile` predate the current code and need updating.
- The installer prints an "Admin password" that is never applied. Create the first admin as described below.

Until these are fixed, install from source.

### Install from source

> This route follows the code but has not yet been run end to end on a real server. Treat the commands as a starting point and check each step.

**1. Install the tools**

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git python3 curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs
sudo corepack enable
```

**2. Get the code**

```bash
sudo git clone https://github.com/iamPrashanta/deploy-king-platform.git /opt/deploy-king
cd /opt/deploy-king && sudo pnpm install --frozen-lockfile
```

**3. Start PostgreSQL and Redis.** First change `POSTGRES_PASSWORD` in `docker-compose.yml`, then:

```bash
sudo docker compose up -d dbbkp-postgres dbbkp-redis
```

**4. Write `.env`** as in development, but with production values:
- strong `JWT_SECRET`, `INTERNAL_SECRET` and `MASTER_KEY` (keep a copy of `MASTER_KEY`: without it, stored variables cannot be read)
- `DBBKP_TLS=true`
- `DBBKP_BASE_DOMAIN=example.com`
- `SITES_ROOT=/var/www/sites`
- `GITHUB_WEBHOOK_SECRET` if you deploy on push

**5. Create the database and the first admin**

```bash
sudo bash -c "set -a; . ./.env; set +a; pnpm db:migrate && INITIAL_ADMIN_PASSWORD='choose-a-strong-password' pnpm db:seed"
```

**6. Start Traefik with HTTPS** (Let's Encrypt, TLS challenge):

```bash
sudo docker network create dbbkp
sudo docker run -d --name dbbkp-traefik --restart unless-stopped --network dbbkp \
  -p 80:80 -p 443:443 --add-host host.docker.internal:host-gateway \
  -v /var/run/docker.sock:/var/run/docker.sock:ro -v /opt/deploy-king/data/letsencrypt:/letsencrypt \
  -v /opt/deploy-king/traefik:/etc/traefik/dynamic:ro \
  traefik:v3.1 \
  --providers.docker=true --providers.docker.exposedbydefault=false --providers.docker.network=dbbkp \
  --providers.file.directory=/etc/traefik/dynamic \
  --entrypoints.web.address=:80 --entrypoints.websecure.address=:443 \
  --certificatesresolvers.letsencrypt.acme.tlschallenge=true \
  --certificatesresolvers.letsencrypt.acme.email=you@example.com \
  --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
```

Save this as `/opt/deploy-king/traefik/panel.yml`. It sends the panel's address to the panel on the host:

```yaml
http:
  routers:
    panel:
      rule: Host(`portal.example.com`)
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: panel
  services:
    panel:
      loadBalancer:
        servers: [{ url: "http://host.docker.internal:3000" }]
```

The panel's port 3000 must be reachable from the Traefik container, but should not be open to the internet. Block it in your firewall.

**7. Build the panel and run the three services.** Use systemd, or pm2:

```bash
sudo pnpm --filter @dbbkp/panel build
# one service each, from /opt/deploy-king:
pnpm --filter @dbbkp/api dev       # API on :4000
pnpm --filter @dbbkp/worker dev    # deploys, workers, scheduled jobs
pnpm --filter @dbbkp/panel start   # panel on :3000
```

**8. Turn on the server watch**

```bash
sudo INSTALL_DIR=/opt/deploy-king bash scripts/install-scan.sh
```

For the Security page to show findings, the API must be able to read `/opt/deploy-king/scan`. For Remove and Undo, it must read and write `/opt/deploy-king/actions`. Set `HOST_SCAN_FILE` and `HOST_ACTIONS_DIR` in `.env` when the API runs directly on the host rather than in a container.

### After installing

- Sign in at `https://portal.example.com` as `admin`, and change the password.
- Open **Security** and accept the first list of what is on the server, so later changes stand out.
- Check **Settings › Server**: capacity, the server checks, cleanup.

---

## Configuration

All settings live in `.env`, at the repository root. The API and the worker find it by themselves; `pnpm db:migrate` and `pnpm db:seed` need it loaded into the shell (`set -a; . ./.env; set +a`). `.env.example` has every setting, with a comment. Put comments on their own lines.

| Setting | What it is | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection | matches `docker-compose.yml`: `postgres://postgres:postgrespassword@localhost:5432/dbbkp_panel` |
| `REDIS_URL` | Redis, for the job queues | `redis://localhost:6379` |
| `JWT_SECRET`, `INTERNAL_SECRET` | Signing sessions, and the key agents use to register | insecure development values; **change them** |
| `MASTER_KEY` | 64 hex characters; encrypts app variables and tokens | all zeros; **change it, and keep it safe** |
| `SITES_ROOT` | Where each app's source is kept | `/var/www/sites` |
| `DBBKP_NETWORK` | Container network shared by Traefik and the apps | `dbbkp` |
| `DBBKP_BASE_DOMAIN` | Apps get `<name>.<this>` | `localhost` |
| `DBBKP_TLS` | `true`: HTTPS with Let's Encrypt. `false`: plain HTTP | `true` |
| `DBBKP_PUBLIC_HTTP_PORT` | Port of Traefik's HTTP entrypoint, used in links | `80` |
| `DEPLOY_KEEP_IMAGES` | Builds kept per app for rollback | `5` |
| `DEPLOY_CONCURRENCY` | Deploys that may build at the same time | `2` |
| `RECONCILE_INTERVAL_MS` | How often running apps are checked | `60000` |
| `GITHUB_WEBHOOK_SECRET` | Secret that deploy-on-push webhooks are signed with | empty: webhooks refused |
| `WORKFLOW_ALLOW_PRIVATE` | Let everyone's workflows call private addresses | `false` |
| `MCP_CALLS_PER_MINUTE` | Rate limit per AI agent token | `120` |
| `HOST_SCAN_FILE` | Where the API reads the server scan | `/host-scan/inventory.json` |
| `HOST_ACTIONS_DIR` | Where the API sends Remove and Undo requests | `/host-actions` |
| `DOCKER_HOST` | The container engine, when it is not `/var/run/docker.sock` (Podman) | the Docker socket |

Capacity, cleanup and the server watch are set in the panel, under **Settings › Server** and **Security**, not in `.env`.

---

## Everyday operations

These scripts belong to the installer layout (`/opt/dbbkp`):

| Script | What it does |
| --- | --- |
| `scripts/doctor.sh` | Health check of the installation |
| `scripts/update.sh` | Updates the platform |
| `scripts/backup-platform.sh`, `scripts/restore-platform.sh` | Back up and restore the platform's own data |
| `scripts/uninstall.sh` | Removes the platform. You choose whether to keep the data. |
| `scripts/install-scan.sh` | Installs or updates the server watch. `--no-actions` installs the scan only; `--remove` turns it off. |
| `scripts/dbbkp.sh` | The `dbbkp` command-line tool for database backups |

After pulling new code, always run `pnpm db:migrate`, with `.env` loaded into the shell as above. The migrations are in `packages/db/drizzle`.

---

## Project layout

| Path | What it is |
| --- | --- |
| `apps/panel` | The web panel (Next.js 15) |
| `apps/api` | The API (Express, tRPC), the MCP server for AI agents, and the WebSocket gateway |
| `apps/worker` | Background jobs (BullMQ): deploys, workers, scheduled jobs, workflows, pipelines |
| `apps/web` | An older interface, no longer used |
| `packages/db` | Database schema and migrations (Drizzle, PostgreSQL) |
| `packages/audit`, `packages/security`, `packages/utils`, … | Shared code: the audit log, encryption, helpers |
| `packages/agent` | A Go agent that reports from servers |
| `scripts/` | The installer, the server scan (`host-scan.py`) and its action helper (`host-act.py`), maintenance scripts |
| `tests/local/` | The local test environment and the checks |

The stack: TypeScript on Node.js, Next.js 15, tRPC, BullMQ on Redis, PostgreSQL with Drizzle, dockerode on Docker or Podman, Traefik v3.

---

## Troubleshooting

**The panel opens but every page fails.** The API is not running on port 4000; the panel forwards to `localhost:4000`.

**A deploy finishes but the app's address does not answer.** Check that:
- Traefik runs on the network named by `DBBKP_NETWORK`
- the address uses the port in `DBBKP_PUBLIC_HTTP_PORT` (8088 in development)
- `DBBKP_TLS=false` when you have no certificate

**"connect ENOENT /var/run/docker.sock".** The worker cannot reach the container engine. Start Docker. With Podman, set `DOCKER_HOST` to its socket.

**Podman on Windows starts no container at all** (`crun: controller pids is not available`). This is a known incompatibility between WSL 3.0.5 and Podman 6.1.2. Updating Podman and recreating the machine fixes it, but recreating the machine deletes its volumes, including other projects' data.

**Ports 80 or 443 are already taken on a server.** That is expected on a used server. The installer then installs side by side; see [What the installer checks](#what-the-installer-checks-scriptsinstallsh).

**The Security page says the server watch is not running.** Run `sudo bash scripts/install-scan.sh`. Check that the API can read the scan folder (`HOST_SCAN_FILE`).

---

## License

Deploy King is licensed under the **Functional Source License, Version 1.1, with Apache 2.0 future license** (`FSL-1.1-ALv2`), © 2026 Prashanta Mondal. See [LICENSE](LICENSE).

In plain words (the [LICENSE](LICENSE) text is what counts):

- You may use, copy, change and self-host Deploy King, at work or at home, for your own servers and for clients you do professional work for.
- You may **not** offer Deploy King, or something substantially like it built from this code, to others as a commercial product or service (a competing hosting panel or deploy service).
- Each version becomes **Apache 2.0** two years after it is released.

Code published up to and including commit `4b98665` (15 November 2026) was released under the MIT License, and stays available under MIT.

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) and the [Contributor License Agreement](legal/CLA.md).
- Reporting a security problem: [SECURITY.md](SECURITY.md).
- Terms, privacy, refunds and acceptable use for Deploy King Desktop and Deploy King Cloud: [legal/](legal/).
