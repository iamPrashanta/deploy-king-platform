# DBBKP Local Docker Development Setup Guide

> Complete end-to-end guide for running the DBBKP control plane locally inside Docker using Docker Socket orchestration.

---

# 🏗️ What This Setup Does

This setup creates:

```text id="wjkvxf"
Windows/Linux/macOS Host
 └── Docker Engine
      └── ubuntu-test (Dev Control Plane Container)
            ├── Next.js Panel
            ├── tRPC API
            ├── BullMQ Workers
            ├── Reconciliation Engine
            ├── WebSocket Gateway
            └── Docker CLI → Host Docker Engine
```

The `ubuntu-test` container acts as a development control plane that can orchestrate real containers on the host Docker engine using:

```text id="uww5x0"
/var/run/docker.sock
```

This is similar to how:

* Coolify
* Dokploy
* Portainer
* Internal PaaS systems

operate.

---

# ⚠️ Security Warning

This setup mounts:

```text id="xuh44r"
/var/run/docker.sock
```

into the container.

This gives the container full control over the host Docker engine.

The container can:

* create containers
* remove containers
* mount volumes
* inspect networks
* effectively gain root-equivalent control over the Docker host

DO NOT:

* expose this publicly
* use with untrusted users
* run in production without proper RBAC and isolation

---

# ✅ Prerequisites

Install:

* Docker Desktop (Windows/macOS)
  OR
* Docker Engine (Linux)

Verify:

```bash id="4hn9g3"
docker version
docker ps
```

---

# 🚀 STEP 1 — Create Development Container

Open PowerShell (Windows) or terminal (Linux/macOS).

Run:

## Windows PowerShell

```powershell id="1m8t8z"
docker run -it `
  --name ubuntu-test `
  --hostname ubuntu-test `
  -p 3000:3000 `
  -p 4000:4000 `
  -p 5173:5173 `
  -v /var/run/docker.sock:/var/run/docker.sock `
  ubuntu:24.04 bash
```

## Linux/macOS

```bash id="jlwm7p"
docker run -it \
  --name ubuntu-test \
  --hostname ubuntu-test \
  -p 3000:3000 \
  -p 4000:4000 \
  -p 5173:5173 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ubuntu:24.04 bash
```

---

# 🔧 STEP 2 — Install System Dependencies

Inside container:

```bash id="7j5c6s"
apt update

apt install -y \
  git \
  curl \
  nano \
  vim \
  docker.io \
  build-essential \
  python3 \
  make \
  gcc \
  g++
```

---

# 🟢 STEP 3 — Install Node.js 22

Inside container:

```bash id="j4znqs"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -

apt install -y nodejs
```

Verify:

```bash id="y7avb5"
node -v
npm -v
```

---

# 📦 STEP 4 — Install pnpm

```bash id="3zcw7o"
npm install -g pnpm
```

Verify:

```bash id="t4m5v4"
pnpm -v
```

---

# 📥 STEP 5 — Clone Repository

```bash id="87zh1q"
git clone YOUR_REPO_URL dbbkp-platform

cd dbbkp-platform
```

---

# 📚 STEP 6 — Install Dependencies

```bash id="wyu4r9"
pnpm install
```

---

# 🟥 STEP 7 — Start Redis

Inside container:

```bash id="xgk8m9"
docker run -d \
  --name redis-dev \
  -p 6379:6379 \
  redis:7-alpine
```

Verify:

```bash id="u5h6j8"
docker ps
```

---

# 🟦 STEP 8 — Start PostgreSQL

Inside container:

```bash id="g7y9k1"
docker run -d \
  --name postgres-dev \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=dbbkp \
  -p 5432:5432 \
  postgres:16-alpine
```

Verify:

```bash id="svm9n2"
docker ps
```

---

# ⚙️ STEP 9 — Configure Environment Variables

Create root `.env`:

```bash id="mv9k4x"
nano .env
```

Add:

```env id="w0v4xq"
DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/dbbkp
REDIS_HOST=host.docker.internal
JWT_SECRET=change-this-in-production
```

Save:

* CTRL + O
* Enter
* CTRL + X

---

# 🗄️ STEP 10 — Generate Database Migrations

```bash id="ymv2p4"
pnpm --filter @dbbkp/db db:generate
```

---

# 🧱 STEP 11 — Run Database Migrations

```bash id="zv4x7w"
export DATABASE_URL="postgres://postgres:postgres@host.docker.internal:5432/dbbkp"

pnpm --filter @dbbkp/db db:migrate
```

---

# 🌱 STEP 12 — Seed Database

```bash id="w6u2t5"
pnpm --filter @dbbkp/db db:seed
```

You will receive bootstrap credentials:

```text id="jqm4h7"
Username: admin
Password: <generated-password>
```

Save the password immediately.

---

# 🚀 STEP 13 — Start DBBKP

```bash id="m9k4w2"
pnpm dev
```

Wait until you see:

```text id="x5u7w8"
[API] Server Ready
[API] URL: http://localhost:4000
```

and:

```text id="p2k4v6"
✓ Ready
```

---

# 🌐 STEP 14 — Access Services

From your host browser:

| Service       | URL                                            |
| ------------- | ---------------------------------------------- |
| Panel         | [http://localhost:3000](http://localhost:3000) |
| API           | [http://localhost:4000](http://localhost:4000) |
| Vite Frontend | [http://localhost:5173](http://localhost:5173) |

---

# 🔐 First Login

Use:

* Username: `admin`
* Password: generated during seed

The system will require mandatory password rotation.

---

# 🧠 Architecture Notes

DBBKP implements:

* Desired State Reconciliation
* Execution Broker
* BullMQ Worker Runtime
* Docker Orchestration
* RBAC
* Audit Logging
* WebSocket Gateway
* Security Reconciliation
* Infrastructure Control Plane patterns

This local environment simulates a real distributed orchestration platform.

---

# 🐳 Important Docker Networking Concept

Inside container:

```text id="k8v2n1"
localhost
```

means:

```text id="x5w7q3"
the container itself
```

NOT sibling containers.

Because:

* `postgres-dev`
* `redis-dev`
* `ubuntu-test`

are separate sibling containers.

Therefore:

```text id="z4n8q2"
host.docker.internal
```

is used to access services exposed by the host Docker engine.

---

# 🔍 Useful Commands

## View Running Containers

```bash id="u9x4m1"
docker ps
```

## View Logs

```bash id="w8q2v5"
docker logs <container-name>
```

## Enter Existing Dev Container

```bash id="m5v7x1"
docker exec -it ubuntu-test bash
```

## Restart Development Container

```bash id="k4n8w2"
docker start ubuntu-test
docker exec -it ubuntu-test bash
```

---

# 🧹 Clean Reset

## Stop Containers

```bash id="n2x5q8"
docker stop ubuntu-test postgres-dev redis-dev
```

## Remove Containers

```bash id="q7v1m4"
docker rm ubuntu-test postgres-dev redis-dev
```

---

# ⚠️ Current Known Limitations

At this stage:

* local DNS routing is incomplete
* Traefik auto-routing may not yet be fully configured
* custom domains require hosts-file or DNS configuration
* some deployment flows may still be in provisioning state

This is expected during local orchestration development.


running entirely inside a Docker-based development control plane.
