import fs from "fs";
import path from "path";
import { createBuildPlan, type BuildPlan, type SiteBuildSettings, GENERATED_DOCKERFILE } from "./index";

/**
 * Project check.
 *
 * Runs before anything is built and answers three questions for the user:
 * what is this project, can Deploy King run it, and what do we still need from
 * you. It only reads files, so it is safe to run on any repository.
 */

export type CheckLevel = "ok" | "info" | "warn" | "bad";
export type Verdict = "ready" | "needs-input" | "not-deployable";
export type ServiceKind = "postgres" | "mysql" | "mongodb" | "redis";

export interface Finding {
  id: string;
  level: CheckLevel;
  title: string;
  detail?: string;
}

export interface Fact {
  label: string;
  value: string;
}

export interface EnvHint {
  key: string;
  /** Value as written in the example file, shown as a hint. */
  example: string;
  /** Value to start from: the example value, or "" when it is a placeholder. */
  value: string;
  /** The example value is a placeholder that has to be replaced. */
  placeholder: boolean;
  /** A random secret is fine, so the panel can generate one. */
  canGenerate: boolean;
  /** Format of a generated secret: 64 hex characters, or Laravel's "base64:" key. */
  generator?: "hex" | "laravel";
  /** The app's own public URL (NEXTAUTH_URL, APP_URL, ...); the panel fills in the domain. */
  appUrl?: boolean;
  /** Set by Deploy King itself (PORT, HOST, ...); the user never needs to fill it in. */
  platform: boolean;
  /** Example file the variable came from. */
  source: string;
}

export interface QuestionOption {
  value: string;
  label: string;
  detail?: string;
}

/** Something the user has to decide before the first deploy. */
export interface Question {
  id: string;
  kind: "confirm" | "select";
  title: string;
  detail?: string;
  options?: QuestionOption[];
  default: string;
  /** Value the question is about, e.g. the port found in the code. */
  suggested?: string;
}

export interface ProjectReport {
  verdict: Verdict;
  summary: string;
  framework: string | null;
  runtime: string | null;
  port: number | null;
  facts: Fact[];
  checks: Finding[];
  env: EnvHint[];
  services: ServiceKind[];
  questions: Question[];
  plan: {
    runtime: string;
    port: number;
    notes: string[];
    dockerfile: string;
    usesRepoDockerfile: boolean;
  } | null;
  /** The planner's error when the project cannot be built as is. */
  error: string | null;
  stats: { files: number; bytes: number; truncated: boolean };
}

// ─── file helpers ────────────────────────────────────────────────────────────

const has = (dir: string, ...parts: string[]) => fs.existsSync(path.join(dir, ...parts));
const read = (dir: string, file: string, max = 512 * 1024) => {
  try {
    const p = path.join(dir, file);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return "";
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const readJson = (dir: string, file: string): any => {
  try {
    return JSON.parse(read(dir, file) || "null");
  } catch {
    return null;
  }
};

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache"]);

function walk(dir: string, limit = 50_000) {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const exts = new Map<string, number>();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(cur, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (++files > limit) {
        truncated = true;
        return { files, bytes, truncated, exts };
      }
      try {
        bytes += fs.statSync(path.join(cur, e.name)).size;
      } catch {}
      const ext = path.extname(e.name).toLowerCase() || e.name.toLowerCase();
      exts.set(ext, (exts.get(ext) ?? 0) + 1);
    }
  }
  return { files, bytes, truncated, exts };
}

const formatBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

// ─── detection ───────────────────────────────────────────────────────────────

const NODE_FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/node", "Remix"],
  ["@remix-run/react", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["gatsby", "Gatsby"],
  ["@angular/core", "Angular"],
  ["@nestjs/core", "NestJS"],
  ["react-scripts", "Create React App"],
  ["@docusaurus/core", "Docusaurus"],
  ["vitepress", "VitePress"],
  ["fastify", "Fastify"],
  ["hono", "Hono"],
  ["koa", "Koa"],
  ["express", "Express"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["react", "React"],
  ["vite", "Vite"],
];
const NODE_SERVER_FRAMEWORKS = new Set(["Next.js", "Nuxt", "Remix", "SvelteKit", "NestJS", "Fastify", "Hono", "Koa", "Express"]);

function nodeFramework(pkg: any): string | null {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const [name, label] of NODE_FRAMEWORKS) if (deps[name]) return label;
  return null;
}

function pythonText(dir: string) {
  return (read(dir, "requirements.txt") + "\n" + read(dir, "pyproject.toml") + "\n" + read(dir, "Pipfile")).toLowerCase();
}

function pythonFramework(dir: string): string | null {
  const t = pythonText(dir);
  if (has(dir, "manage.py") || /\bdjango\b/.test(t)) return "Django";
  if (/\bfastapi\b/.test(t)) return "FastAPI";
  if (/\bflask\b/.test(t)) return "Flask";
  if (/\bstreamlit\b/.test(t)) return "Streamlit";
  if (/\bgradio\b/.test(t)) return "Gradio";
  return null;
}

function phpFramework(dir: string): string | null {
  const composer = readJson(dir, "composer.json");
  const req = { ...(composer?.require || {}) };
  if (has(dir, "artisan") || req["laravel/framework"]) return "Laravel";
  if (req["symfony/framework-bundle"]) return "Symfony";
  if (has(dir, "wp-content") || has(dir, "wp-config-sample.php") || has(dir, "wp-config.php")) return "WordPress";
  return null;
}

function goFramework(dir: string): string | null {
  const mod = read(dir, "go.mod");
  if (mod.includes("github.com/gin-gonic/gin")) return "Gin";
  if (mod.includes("github.com/labstack/echo")) return "Echo";
  if (mod.includes("github.com/gofiber/fiber")) return "Fiber";
  if (mod.includes("github.com/go-chi/chi")) return "chi";
  return null;
}

function nodePackageManager(dir: string): string {
  if (has(dir, "pnpm-lock.yaml")) return "pnpm";
  if (has(dir, "yarn.lock")) return "yarn";
  if (has(dir, "bun.lockb") || has(dir, "bun.lock")) return "bun";
  return "npm";
}

function pythonPackageManager(dir: string): string {
  if (has(dir, "uv.lock")) return "uv";
  if (has(dir, "poetry.lock")) return "poetry";
  if (has(dir, "Pipfile")) return "pipenv";
  return "pip";
}

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist", "example.env", ".env.local.example", ".env.development.example"];

/** Variables Deploy King sets on every container. */
const PLATFORM_VARS = new Set(["PORT", "HOST", "HOSTNAME", "NODE_ENV"]);

const THIRD_PARTY = /^(STRIPE|AWS|S3_|GITHUB|GITLAB|GOOGLE|GCP|OPENAI|ANTHROPIC|SENDGRID|MAILGUN|MAILCHIMP|POSTMARK|RESEND|TWILIO|SUPABASE|CLOUDINARY|FIREBASE|PAYPAL|RAZORPAY|SLACK|DISCORD|TELEGRAM|SENTRY|ALGOLIA|PUSHER|CLERK|AUTH0|OKTA|SMTP|MAIL_|SPOTIFY|TWITTER|FACEBOOK|META_|LINKEDIN|HUGGING|REPLICATE|GROQ|MISTRAL|COHERE|PINECONE|UPSTASH|VERCEL|NETLIFY)/;
const GENERATABLE = /(SECRET|SALT|SIGNING_KEY|ENCRYPTION_KEY|^APP_KEY$|^SECRET_KEY$|^JWT_|^SESSION_|^COOKIE_|^NEXTAUTH_SECRET$|^AUTH_SECRET$)/;

function isPlaceholder(value: string) {
  const v = value.trim();
  if (!v) return true;
  return (
    /^<.*>$/.test(v) ||
    /^(x{3,}|\.\.\.|\*+|todo|tbd|none|null|changeme|change[-_ ]?me|replace[-_ ]?me|secret|your[-_ ].*|.*[-_]here|sk_test_\.\.\.|pk_test_\.\.\.)$/i.test(v) ||
    /\byour[-_ ]/i.test(v) ||
    /^(xxx|abc|123456|password)$/i.test(v)
  );
}

const APP_URL_VARS = /^(NEXTAUTH_URL|AUTH_URL|APP_URL|SITE_URL|PUBLIC_URL|BASE_URL|NEXT_PUBLIC_(SITE|APP|BASE)_URL|VITE_(APP|SITE|BASE)_URL|ORIGIN|FRONTEND_URL|WEBSITE_URL)$/;
// Connection settings whose example value points at the developer's own machine, which is useless in a container.
const LOCAL_ONLY = /(^DATABASE_URL$|_DATABASE_URL$|_URI$|^REDIS_URL$|^MONGO(DB)?_URL$|^DB_HOST$|^REDIS_HOST$|^POSTGRES_HOST$|^MYSQL_HOST$)/;
const isLocal = (v: string) => /(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)/i.test(v);

function parseEnvExample(dir: string): EnvHint[] {
  const out = new Map<string, EnvHint>();
  for (const file of ENV_EXAMPLE_FILES) {
    const text = read(dir, file, 64 * 1024);
    if (!text) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1] ?? "";
      if (out.has(key)) continue;
      let value = (m[2] ?? "").trim();
      const quoted = value.match(/^(['"])(.*)\1/);
      value = quoted ? (quoted[2] ?? "") : value.replace(/\s+#.*$/, "");
      const appUrl = APP_URL_VARS.test(key);
      const placeholder = isPlaceholder(value) || (LOCAL_ONLY.test(key) && isLocal(value));
      const canGenerate = placeholder && GENERATABLE.test(key) && !THIRD_PARTY.test(key);
      out.set(key, {
        key,
        example: value,
        value: placeholder || appUrl ? "" : value,
        placeholder: placeholder && !appUrl,
        canGenerate,
        ...(canGenerate ? { generator: key === "APP_KEY" ? ("laravel" as const) : ("hex" as const) } : {}),
        ...(appUrl ? { appUrl: true } : {}),
        platform: PLATFORM_VARS.has(key),
        source: file,
      });
    }
  }
  return [...out.values()].slice(0, 100);
}

function detectServices(dir: string, framework: string | null, env: EnvHint[]): ServiceKind[] {
  const pkg = readJson(dir, "package.json");
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const py = pythonText(dir);
  const composer = JSON.stringify(readJson(dir, "composer.json")?.require || {});
  const gomod = read(dir, "go.mod");
  const prisma = (read(dir, "prisma/schema.prisma") || read(dir, "schema.prisma")).match(/provider\s*=\s*"(postgresql|mysql|mongodb|sqlite|cockroachdb)"/)?.[1];
  const envText = env.map((e) => `${e.key}=${e.value}`).join("\n");
  const envDb = envText.match(/^(?:DB_CONNECTION|DATABASE_ENGINE)=(\w+)/m)?.[1]?.toLowerCase();
  const dbUrl = envText.match(/^DATABASE_URL=(\w+):/m)?.[1]?.toLowerCase();

  const found = new Set<ServiceKind>();
  if (
    deps.pg || deps.postgres || deps["@neondatabase/serverless"] || deps["pg-promise"] ||
    prisma === "postgresql" || prisma === "cockroachdb" ||
    /\b(psycopg2?|psycopg2-binary|asyncpg|psycopg\[)/.test(py) ||
    gomod.includes("github.com/lib/pq") || gomod.includes("github.com/jackc/pgx") ||
    envDb === "pgsql" || envDb === "postgres" || envDb === "postgresql" || dbUrl?.startsWith("postgres")
  ) found.add("postgres");
  if (
    deps.mysql || deps.mysql2 || prisma === "mysql" ||
    /\b(pymysql|mysqlclient|mysql-connector-python|aiomysql)\b/.test(py) ||
    gomod.includes("github.com/go-sql-driver/mysql") ||
    envDb === "mysql" || envDb === "mariadb" || dbUrl === "mysql" || framework === "WordPress"
  ) found.add("mysql");
  if (deps.mongoose || deps.mongodb || prisma === "mongodb" || /\b(pymongo|motor|mongoengine)\b/.test(py) || gomod.includes("go.mongodb.org/mongo-driver") || dbUrl?.startsWith("mongodb"))
    found.add("mongodb");
  if (deps.redis || deps.ioredis || deps.bullmq || deps.bull || /\b(redis|django-redis|celery\[redis\])\b/.test(py) || composer.includes("predis") || gomod.includes("redis/go-redis") || /^REDIS_(URL|HOST)=/m.test(envText))
    found.add("redis");
  return [...found];
}

const SERVICE_LABEL: Record<ServiceKind, string> = { postgres: "PostgreSQL", mysql: "MySQL", mongodb: "MongoDB", redis: "Redis" };
const SERVICE_VAR: Record<ServiceKind, string> = { postgres: "DATABASE_URL", mysql: "DATABASE_URL", mongodb: "MONGODB_URI", redis: "REDIS_URL" };

/** Port the code itself listens on when it ignores $PORT, e.g. `app.listen(8080)`. */
function hardcodedPort(dir: string, pkg: any): { port: number; file: string } | null {
  const candidates = [
    pkg?.main,
    "server.js", "index.js", "app.js", "main.js", "server.mjs", "index.mjs",
    "src/server.js", "src/index.js", "src/app.js", "src/main.js",
    "src/server.ts", "src/index.ts", "src/app.ts", "src/main.ts",
    "main.py", "app.py", "server.py", "run.py",
    "main.go", "cmd/server/main.go",
  ].filter((f): f is string => typeof f === "string" && !f.includes(".."));
  for (const file of [...new Set(candidates)]) {
    const text = read(dir, file, 256 * 1024);
    if (!text) continue;
    if (/process\.env\.PORT|process\.env\[['"]PORT['"]\]|os\.environ(?:\.get)?\(?\[?['"]PORT['"]|os\.getenv\(['"]PORT['"]|os\.Getenv\("PORT"\)/.test(text)) return null;
    const m =
      text.match(/\.listen\(\s*(\d{2,5})\b/) ||
      text.match(/ListenAndServe\(\s*"[^"]*:(\d{2,5})"/) ||
      text.match(/\.run\([^)]*\bport\s*=\s*(\d{2,5})/) ||
      text.match(/\bPORT\s*=\s*(\d{2,5})\b/);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port < 65536) return { port, file };
    }
  }
  return null;
}

function scriptsOnly(exts: Map<string, number>) {
  const total = [...exts.values()].reduce((a, b) => a + b, 0);
  const scripts = (exts.get(".sh") ?? 0) + (exts.get(".bash") ?? 0);
  return scripts > 0 && scripts / Math.max(1, total) > 0.3;
}

function isMonorepo(dir: string, pkg: any) {
  return has(dir, "pnpm-workspace.yaml") || has(dir, "turbo.json") || has(dir, "lerna.json") || has(dir, "nx.json") || Array.isArray(pkg?.workspaces) || !!pkg?.workspaces?.packages;
}

const RUNTIME_LABEL: Record<string, string> = {
  static: "Static site (nginx)",
  node: "Node.js",
  "node-static": "Static build (nginx)",
  python: "Python",
  php: "PHP (Apache)",
  go: "Go",
  docker: "Your Dockerfile",
  image: "Docker image",
};

// ─── main entry ──────────────────────────────────────────────────────────────

export function analyzeProject(dir: string, site: SiteBuildSettings = { type: "auto" }): ProjectReport {
  const checks: Finding[] = [];
  const facts: Fact[] = [];
  const questions: Question[] = [];
  const pkg = readJson(dir, "package.json");
  const stats = walk(dir);

  // 1. Can we build it at all?
  let plan: BuildPlan | null = null;
  let error: string | null = null;
  try {
    plan = createBuildPlan(dir, site);
  } catch (err: any) {
    error = String(err?.message || err);
  }

  const runtime = plan?.runtime ?? null;
  const framework =
    (has(dir, "package.json") ? nodeFramework(pkg) : null) ??
    pythonFramework(dir) ??
    phpFramework(dir) ??
    goFramework(dir) ??
    (runtime === "static" ? "Static HTML" : null);

  const env = parseEnvExample(dir);
  const services = detectServices(dir, framework, env);

  // 2. Facts shown at the top of the report
  if (framework) facts.push({ label: "Framework", value: framework });
  if (runtime) facts.push({ label: "Runs as", value: RUNTIME_LABEL[runtime] ?? runtime });
  if (plan) facts.push({ label: "Port", value: String(plan.port) });
  if (pkg) {
    facts.push({ label: "Package manager", value: nodePackageManager(dir) });
    if (pkg.scripts?.build) facts.push({ label: "Build", value: String(pkg.scripts.build).slice(0, 120) });
    if (pkg.scripts?.start) facts.push({ label: "Start", value: String(pkg.scripts.start).slice(0, 120) });
    if (pkg.engines?.node) facts.push({ label: "Node.js", value: String(pkg.engines.node) });
  } else if (runtime === "python") {
    facts.push({ label: "Package manager", value: pythonPackageManager(dir) });
  } else if (has(dir, "composer.json")) {
    facts.push({ label: "Package manager", value: "composer" });
  }
  if (services.length) facts.push({ label: "Uses", value: services.map((s) => SERVICE_LABEL[s]).join(", ") });
  const needValues = env.filter((e) => e.placeholder && !e.platform && !e.appUrl);
  if (env.length) facts.push({ label: "Variables", value: `${env.length} in ${env[0]?.source ?? ""}` });
  facts.push({ label: "Size", value: `${stats.truncated ? "over " : ""}${stats.files.toLocaleString("en")} files, ${formatBytes(stats.bytes)}` });

  // 3. Checks
  // A library can still "plan" (node index.js) and then exit straight away.
  const looksLibrary =
    !!pkg && !pkg.scripts?.start && !site.startCommand && !has(dir, "Procfile") && !has(dir, "Dockerfile") &&
    !(framework && NODE_SERVER_FRAMEWORKS.has(framework)) && plan?.runtime !== "node-static" && !!(pkg.bin || pkg.types || pkg.exports);
  if (looksLibrary) {
    checks.push({
      id: "runnable",
      level: "bad",
      title: "Looks like a library or CLI, not a web app",
      detail: 'package.json publishes a package (bin/types/exports), has no "start" script and no web framework. Set a start command that runs a server, or add a Dockerfile.',
    });
  } else if (plan) {
    checks.push({
      id: "runnable",
      level: "ok",
      title: `Can be built and served as ${RUNTIME_LABEL[plan.runtime] ?? plan.runtime}`,
      detail: plan.notes.join(". "),
    });
  } else if (scriptsOnly(stats.exts) && !has(dir, "package.json") && !has(dir, "index.html")) {
    checks.push({
      id: "runnable",
      level: "bad",
      title: "No web server",
      detail: "This repository is mostly shell scripts, so it looks like a command-line tool. Deploy King runs websites and web services that answer HTTP requests.",
    });
  } else {
    checks.push({ id: "runnable", level: "bad", title: "Could not work out how to run it", detail: error ?? undefined });
  }

  if (plan?.runtime === "docker") {
    const dockerText = read(dir, "Dockerfile");
    if (!/^\s*EXPOSE\s/im.test(dockerText) && !site.port) {
      checks.push({ id: "expose", level: "warn", title: "Dockerfile has no EXPOSE", detail: "Assuming the app listens on port 80. Set the port in Configure if it uses another one." });
    }
  }

  if (pkg && !["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "bun.lock"].some((f) => has(dir, f))) {
    checks.push({ id: "lockfile", level: "warn", title: "No lockfile", detail: "Dependencies are resolved fresh on every deploy, so two deploys of the same commit can differ." });
  } else if (pkg) {
    checks.push({ id: "lockfile", level: "ok", title: "Lockfile found", detail: "Installs are reproducible." });
  }
  if (has(dir, "bun.lockb") || has(dir, "bun.lock")) {
    checks.push({ id: "bun", level: "info", title: "Bun lockfile found", detail: "The app is installed with npm. Add a Dockerfile to build with Bun." });
  }

  if (has(dir, ".env")) {
    checks.push({
      id: "dotenv",
      level: "warn",
      title: ".env is committed to the repository",
      detail: "Anyone with access to the repository can read it. Move the values into this app's variables.",
    });
  }

  const serviceVar = (s: ServiceKind) => {
    const keys = new Set(env.map((e) => e.key));
    if (s === "redis") return ["REDIS_URL", "REDIS_HOST"].find((k) => keys.has(k)) ?? SERVICE_VAR[s];
    if (s === "mongodb") return ["MONGODB_URI", "MONGO_URI", "MONGO_URL", "MONGODB_URL", "DATABASE_URL"].find((k) => keys.has(k)) ?? SERVICE_VAR[s];
    return ["DATABASE_URL", "POSTGRES_URL", "MYSQL_URL", "DB_HOST"].find((k) => keys.has(k)) ?? SERVICE_VAR[s];
  };
  for (const s of services) {
    checks.push({ id: `service:${s}`, level: "info", title: `Needs ${SERVICE_LABEL[s]}`, detail: `Connect it with ${serviceVar(s)}.` });
  }
  const prisma = (read(dir, "prisma/schema.prisma") || read(dir, "schema.prisma")).match(/provider\s*=\s*"sqlite"/);
  if (prisma || pkg?.dependencies?.["better-sqlite3"] || pkg?.dependencies?.sqlite3 || /sqlite3/.test(read(dir, "settings.py") + read(dir, `${path.basename(dir)}/settings.py`))) {
    checks.push({ id: "sqlite", level: "warn", title: "Stores data in SQLite", detail: "Add a volume for the database file, or the data is lost on every deploy." });
  }

  if (needValues.length) {
    const gen = needValues.filter((e) => e.canGenerate).length;
    const manual = needValues.length - gen;
    checks.push({
      id: "env",
      level: manual ? "warn" : "info",
      title: `${needValues.length} variable${needValues.length === 1 ? " needs" : "s need"} a value`,
      detail: [manual ? `${manual} to fill in` : "", gen ? `${gen} can be generated` : ""].filter(Boolean).join(", "),
    });
  }

  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) => has(dir, f));
  if (compose && !has(dir, "Dockerfile")) {
    checks.push({ id: "compose", level: "warn", title: `${compose} found`, detail: "Deploy King deploys one service per app, so only the main app is built. Add each other service (database, worker) separately." });
  }
  if (isMonorepo(dir, pkg)) {
    checks.push({ id: "monorepo", level: "warn", title: "Monorepo", detail: "The whole repository is built as one app. Set Root directory to the app's folder, or, if the app needs other packages from the workspace, add a Dockerfile at the repository root that builds it." });
  }
  if (stats.bytes > 500 * 1024 ** 2) {
    checks.push({ id: "size", level: "warn", title: `Large repository (${formatBytes(stats.bytes)})`, detail: "Builds will be slow. Keep build output and media out of git." });
  }

  // 4. Questions for the user
  if (plan && ["node", "python", "go"].includes(plan.runtime) && !site.port) {
    const hard = hardcodedPort(dir, pkg);
    if (hard && hard.port !== plan.port) {
      questions.push({
        id: "port",
        kind: "confirm",
        title: `Your app listens on port ${hard.port}`,
        detail: `${hard.file} uses ${hard.port} instead of reading $PORT. Route traffic to ${hard.port}?`,
        default: "yes",
        suggested: String(hard.port),
      });
    }
  }
  for (const s of services) {
    const v = serviceVar(s);
    const declared = env.find((e) => e.key === v);
    questions.push({
      id: `service:${s}`,
      kind: "select",
      title: `This app uses ${SERVICE_LABEL[s]}`,
      detail: `Where should ${v} point?`,
      options: [
        { value: "existing", label: `I have a ${SERVICE_LABEL[s]} server`, detail: `Fill in ${v} below` },
        { value: "later", label: "I'll set it up later", detail: "The app may fail its health check until it can connect" },
      ],
      default: declared && !declared.placeholder ? "later" : "existing",
    });
  }

  // 5. Verdict
  const manualCount = needValues.filter((e) => !e.canGenerate).length;
  const blocking = checks.filter((c) => c.level === "bad");
  const verdict: Verdict = blocking.length ? "not-deployable" : questions.length || needValues.some((e) => !e.canGenerate) ? "needs-input" : "ready";
  const what = framework ? `${framework} app` : runtime ? `${RUNTIME_LABEL[runtime] ?? runtime} app` : "This project";
  const summary =
    verdict === "not-deployable"
      ? `${blocking[0]?.title ?? "Not deployable"}.`
      : verdict === "ready"
        ? `${what} on port ${plan!.port}. Ready to deploy.`
        : `${what} on port ${plan!.port}. ${[
            services.length ? `It needs ${services.map((s) => SERVICE_LABEL[s]).join(" and ")}` : "",
            manualCount ? `${manualCount} variable${manualCount === 1 ? " needs a value" : "s need values"}` : "",
          ]
            .filter(Boolean)
            .join(", and ") || "A few questions before deploying"}.`;

  let dockerfile: string | null = plan?.dockerfile ?? null;
  if (plan && dockerfile === null) dockerfile = read(dir, plan.dockerfilePath).slice(0, 6000);

  return {
    verdict,
    summary,
    framework,
    runtime,
    port: plan?.port ?? null,
    facts,
    checks,
    env,
    services,
    questions,
    plan: plan
      ? { runtime: plan.runtime, port: plan.port, notes: plan.notes, dockerfile: dockerfile ?? "", usesRepoDockerfile: plan.dockerfilePath !== GENERATED_DOCKERFILE }
      : null,
    error,
    stats: { files: stats.files, bytes: stats.bytes, truncated: stats.truncated },
  };
}
