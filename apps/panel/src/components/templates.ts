/**
 * One-click templates: each is a public Docker image with the port it serves
 * on, the folders that must survive redeploys, and the variables it needs.
 */
export type TemplateVar = { key: string; value?: string; label?: string; secret?: "hex"; appUrl?: boolean; required?: boolean };
export type Template = {
  id: string;
  name: string;
  category: "Automation" | "Monitoring" | "Developer tools" | "Productivity" | "AI" | "Analytics" | "Basics";
  description: string;
  image: string;
  port: number;
  color: string;
  volumes: { name: string; mountPath: string }[];
  env: TemplateVar[];
  docs: string;
  /** Memory limit in MB when the default (512 MB) is too small. */
  memoryMb?: number;
  /** Extra variables used only when the server has no HTTPS (DBBKP_TLS=false). */
  noTlsEnv?: TemplateVar[];
};

export const TEMPLATES: Template[] = [
  {
    id: "n8n", name: "n8n", category: "Automation", color: "#ea4b71",
    description: "Workflow automation with 400+ integrations and a visual editor.",
    image: "n8nio/n8n:latest", port: 5678, memoryMb: 1536,
    volumes: [{ name: "data", mountPath: "/home/node/.n8n" }],
    env: [
      { key: "N8N_ENCRYPTION_KEY", secret: "hex", label: "Encrypts saved credentials" },
      { key: "WEBHOOK_URL", appUrl: true, label: "Public URL for webhooks" },
      { key: "N8N_PROXY_HOPS", value: "1" },
      { key: "GENERIC_TIMEZONE", value: "UTC" },
    ],
    noTlsEnv: [{ key: "N8N_SECURE_COOKIE", value: "false", label: "Lets n8n sign you in over plain http" }],
    docs: "https://docs.n8n.io",
  },
  {
    id: "uptime-kuma", name: "Uptime Kuma", category: "Monitoring", color: "#5cdd8b",
    description: "Self-hosted uptime monitoring with status pages and alerts.",
    image: "louislam/uptime-kuma:1", port: 3001,
    volumes: [{ name: "data", mountPath: "/app/data" }], env: [], docs: "https://github.com/louislam/uptime-kuma",
  },
  {
    id: "gitea", name: "Gitea", category: "Developer tools", color: "#609926",
    description: "Lightweight Git hosting with issues, pull requests and CI.",
    image: "gitea/gitea:1", port: 3000,
    volumes: [{ name: "data", mountPath: "/data" }],
    env: [{ key: "GITEA__server__ROOT_URL", appUrl: true }], docs: "https://docs.gitea.com",
  },
  {
    id: "vaultwarden", name: "Vaultwarden", category: "Productivity", color: "#175ddc",
    description: "Bitwarden-compatible password manager server.",
    image: "vaultwarden/server:latest", port: 80,
    volumes: [{ name: "data", mountPath: "/data" }],
    env: [{ key: "DOMAIN", appUrl: true }, { key: "SIGNUPS_ALLOWED", value: "true", label: "Set to false after creating your account" }],
    docs: "https://github.com/dani-garcia/vaultwarden/wiki",
  },
  {
    id: "grafana", name: "Grafana", category: "Monitoring", color: "#f46800",
    description: "Dashboards and alerting for metrics, logs and traces.",
    image: "grafana/grafana-oss:latest", port: 3000, memoryMb: 768,
    volumes: [{ name: "data", mountPath: "/var/lib/grafana" }],
    env: [{ key: "GF_SERVER_ROOT_URL", appUrl: true }, { key: "GF_SECURITY_ADMIN_PASSWORD", secret: "hex", label: "Password for the admin user" }],
    docs: "https://grafana.com/docs/grafana/latest/",
  },
  {
    id: "metabase", name: "Metabase", category: "Analytics", color: "#509ee3",
    description: "Ask questions about your data and share dashboards.",
    image: "metabase/metabase:latest", port: 3000, memoryMb: 1536,
    volumes: [{ name: "data", mountPath: "/metabase-data" }],
    env: [{ key: "MB_DB_FILE", value: "/metabase-data/metabase.db" }, { key: "MB_SITE_URL", appUrl: true }],
    docs: "https://www.metabase.com/docs/latest/",
  },
  {
    id: "open-webui", name: "Open WebUI", category: "AI", color: "#4b4b57",
    description: "Chat interface for Ollama and OpenAI-compatible models.",
    image: "ghcr.io/open-webui/open-webui:main", port: 8080, memoryMb: 2048,
    volumes: [{ name: "data", mountPath: "/app/backend/data" }],
    env: [{ key: "WEBUI_SECRET_KEY", secret: "hex" }, { key: "OLLAMA_BASE_URL", label: "e.g. http://ollama:11434 (optional)" }],
    docs: "https://docs.openwebui.com",
  },
  {
    id: "memos", name: "Memos", category: "Productivity", color: "#ffa64d",
    description: "Lightweight note taking with Markdown and tags.",
    image: "neosmemo/memos:stable", port: 5230,
    volumes: [{ name: "data", mountPath: "/var/opt/memos" }], env: [], docs: "https://www.usememos.com/docs",
  },
  {
    id: "excalidraw", name: "Excalidraw", category: "Productivity", color: "#6965db",
    description: "Hand-drawn style whiteboard for sketches and diagrams.",
    image: "excalidraw/excalidraw:latest", port: 80, volumes: [], env: [], docs: "https://github.com/excalidraw/excalidraw",
  },
  {
    id: "adminer", name: "Adminer", category: "Developer tools", color: "#34567c",
    description: "Database manager for MySQL, PostgreSQL, SQLite and more in one page.",
    image: "adminer:latest", port: 8080, volumes: [], env: [], docs: "https://www.adminer.org",
  },
  {
    id: "mailpit", name: "Mailpit", category: "Developer tools", color: "#2d9cdb",
    description: "Email testing: catches outgoing mail and shows it in a web inbox.",
    image: "axllent/mailpit:latest", port: 8025, volumes: [], env: [], docs: "https://mailpit.axllent.org",
  },
  {
    id: "nginx", name: "Nginx hello", category: "Basics", color: "#009639",
    description: "The nginx welcome page. A quick way to test domains and HTTPS.",
    image: "nginx:alpine", port: 80, volumes: [], env: [], docs: "https://hub.docker.com/_/nginx",
  },
  {
    id: "whoami", name: "whoami", category: "Basics", color: "#24a1c1",
    description: "Echoes the request headers back. Handy for debugging the proxy.",
    image: "traefik/whoami:latest", port: 80, volumes: [], env: [], docs: "https://github.com/traefik/whoami",
  },
];
