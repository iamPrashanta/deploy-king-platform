# 🛡️ DBBKP — Distributed Infrastructure Control Plane

DBBKP is a **Secure Infrastructure Operating System** and **Distributed Control Plane** designed to automate orchestration, security hardening, and self-healing deployments across a fleet of heterogeneous nodes.

Unlike traditional hosting panels, DBBKP implements a **Desired State Reconciliation** architecture (similar to Kubernetes) to ensure that your infrastructure, security posture, and runtime workloads are always compliant with your defined policies.

---

## 🏛️ Core Architecture

The platform is divided into distinct planes to ensure reliability, security, and scalability:

*   **Control Plane**: API, UI, and RBAC engine (Node.js + tRPC).
*   **Execution Plane**: Policy-driven command execution via the **Execution Broker**.
*   **Security Plane**: Real-time EDR, FIM, and behavioral anomaly detection.
*   **Compliance Plane**: Desired state enforcement and remediation lifecycle.
*   **Data Plane**: Hardened container runtimes and isolated tenant workloads.

---

## ⚡ Key Architectural Features

### 🔄 Desired State Reconciliation
The platform continuously monitors the delta between your **Desired State** (defined in the DB) and the **Observed State** (reported by agents).
- **Self-Healing**: If a container crashes or is deleted, the reconciler automatically restores it.
- **Security Drift**: If a system configuration (like `sshd_config`) is changed manually, the system detects the drift and triggers a remediation plan.

### 🛡️ Execution Broker
All infrastructure mutations flow through a centralized **Execution Broker**. 
- **Intent Validation**: No command is trusted implicitly. Every execution must declare a structured "Intent" (actor, tenant, command class).
- **Hardened Decision Point**: Validates commands against multi-tenant boundaries and security policies before execution.
- **Audit Correlation**: Links every shell command to a specific user session and trace ID for forensic auditability.

### 📦 Runtime Isolation & Quotas
Every deployed workload is isolated using hardened container policies:
- **Resource Quotas**: Enforced via cgroups (CPU shares, Memory limits).
- **Fork-Bomb Protection**: Strict `pids-limit` enforcement.
- **Hardened Security**: `no-new-privileges`, non-root execution, and read-only filesystem policies.
- **Network Isolation**: Egress filtering and outbound telemetry tracking.

---

## 🔍 Security Plane (EDR & Posture)

DBBKP includes a distributed security subsystem that provides deep infrastructure visibility:

- **EDR-Lite**: Real-time process ancestry tracking and behavioral anomaly detection.
- **File Integrity (FIM)**: SHA-256 hashing and entropy analysis to detect web-shells and PHP malware.
- **Network Telemetry**: Ingestion of outbound connections, DNS requests, and risk-based ASN/Geo tracking.
- **Posture Scoring**: Continuous assessment of host security (SSH, Firewall, Users) against a hardened baseline.

---

## 🏢 Compliance & Hardening

Move from "settings" to "policy-driven" governance.

### Security Modes
- **Monitor**: Detect drift and alert only.
- **Guided**: Generate remediation plans for manual approval.
- **Enforce**: Automatically remediate configuration drift.
- **Locked**: Strict, immutable hardened baseline enforcement.

### Policy Packs
Deploy pre-bundled security baselines like **Ubuntu Hardened** or **Hosting Safe Mode** across your fleet with a single click.

---

## 👥 Multi-Tenant Security
- **RBAC Engine**: Granular permission model for developers, admins, and auditors.
- **PTY Auditing**: Every terminal session is recorded, linked to a tenant, and audited for dangerous commands.
- **Ownership Validation**: Strict mapping between containers, volumes, and user IDs.

---

## 🛠️ Technical Stack

- **Backend**: Node.js, tRPC, BullMQ (Async Workers).
- **Frontend**: Next.js 15, xterm.js (Terminal), High-performance WebSockets.
- **Agent**: High-performance Go agent + Autonomous Bash scripts.
- **Storage**: PostgreSQL (Drizzle ORM), Redis (Event Bus).
- **Infrastructure**: Docker Engine, UFW, Systemd.

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Configure Environment
Create a `.env` file based on `.env.example`.

### 3. Setup Database
```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

### 4. Start Control Plane
```bash
pnpm dev
```

---

## 🏁 Summary

DBBKP is built for organizations that need more than a panel—they need a **Secure Infrastructure Operating System**.

*   **PaaS Capability**: Like Coolify / Dokploy.
*   **Security Automation**: Like EDR / Host Hardening.
*   **Self-Healing**: Like Kubernetes.
*   **Unified Visibility**: Like Datadog.

👉 Result: **A unified, secure, and self-healing control plane for distributed infrastructure.**
