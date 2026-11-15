import fs from "fs";
import path from "path";

/**
 * Build planning.
 *
 * Every site, whatever it is written in, is turned into a container image and
 * run from that image. If the repository ships its own Dockerfile we use it;
 * otherwise we inspect the source and generate one. This is what lets a single
 * deploy path serve "any type of website", and it is the seam where a
 * buildpack-style builder (e.g. Railpack) can be plugged in later.
 */

export type Runtime = "static" | "node" | "node-static" | "python" | "php" | "go" | "docker" | "image";

export interface BuildPlan {
  runtime: Runtime;
  /** Port the app listens on inside the container. Traefik routes to this. */
  port: number;
  /** Dockerfile path relative to the build context. */
  dockerfilePath: string;
  /** Generated Dockerfile contents, or null when the repository's own Dockerfile is used. */
  dockerfile: string | null;
  /** Human-readable notes about what was detected, written to the deploy log. */
  notes: string[];
}

export interface SiteBuildSettings {
  type: string; // auto | static | node | python | php | go | docker
  buildCommand?: string | null;
  startCommand?: string | null;
  phpVersion?: string | null;
  /** Port the app listens on, when the user set one. Overrides the runtime's default. */
  port?: number | null;
  /** Node.js major version to build with, overriding package.json "engines". */
  nodeVersion?: string | null;
}

/** Node.js majors Deploy King can build with. */
export const NODE_VERSIONS = ["24", "22", "20", "18", "16"];

const validPort = (p: number | null | undefined) => (p && Number.isInteger(p) && p > 0 && p < 65536 ? p : null);

export const GENERATED_DOCKERFILE = ".dbbkp.Dockerfile";

const STATIC_FRAMEWORKS = [
  "vite",
  "react-scripts",
  "@vue/cli-service",
  "astro",
  "gatsby",
  "parcel",
  "@angular/cli",
  "@11ty/eleventy",
  "vitepress",
  "vuepress",
  "@docusaurus/core",
  "@sveltejs/adapter-static",
];

// Order matters: first directory containing an index.html wins.
const STATIC_OUTPUT_DIRS = ["dist", "build", "out", "public", "_site", ".output/public", "docs/.vitepress/dist"];

const has = (dir: string, ...parts: string[]) => fs.existsSync(path.join(dir, ...parts));
const read = (dir: string, file: string) => {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    return "";
  }
};

/** JSON-array ("exec") form so arbitrary user commands cannot break Dockerfile syntax. */
const sh = (cmd: string) => JSON.stringify(["sh", "-c", cmd]);

/** `web:` entry of a Procfile, if the repository has one. */
function procfileWeb(dir: string): string | null {
  const match = read(dir, "Procfile").match(/^web:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

export function detectRuntime(dir: string): Runtime | null {
  if (has(dir, "Dockerfile")) return "docker";
  if (has(dir, "package.json")) return isStaticNodeBuild(dir, null) ? "node-static" : "node";
  if (has(dir, "requirements.txt") || has(dir, "pyproject.toml") || has(dir, "Pipfile")) return "python";
  if (has(dir, "go.mod")) return "go";
  if (has(dir, "composer.json") || has(dir, "index.php") || has(dir, "public", "index.php")) return "php";
  if (has(dir, "index.html") || STATIC_OUTPUT_DIRS.some((d) => has(dir, d, "index.html"))) return "static";
  return null;
}

function readPackageJson(dir: string): any {
  try {
    return JSON.parse(read(dir, "package.json") || "{}");
  } catch {
    throw new Error("package.json is not valid JSON");
  }
}

function isStaticNodeBuild(dir: string, startCommand: string | null | undefined): boolean {
  if (startCommand || procfileWeb(dir)) return false;
  const pkg = readPackageJson(dir);
  const scripts = pkg.scripts || {};
  if (scripts.start || !scripts.build) return false;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return STATIC_FRAMEWORKS.some((name) => deps[name]);
}

function nodeVersion(pkg: any, override?: string | null): string {
  if (override && NODE_VERSIONS.includes(override)) return override;
  const m = String(pkg?.engines?.node || "").match(/(\d{2})/);
  const major = m ? Number(m[1]) : 22;
  return major >= 18 && major <= 24 ? String(major) : "22";
}

function nodeInstall(dir: string): { manifests: string[]; setup: string[]; install: string; run: (script: string) => string } {
  if (has(dir, "pnpm-lock.yaml")) {
    return {
      manifests: ["package.json", "pnpm-lock.yaml", ...(has(dir, ".npmrc") ? [".npmrc"] : [])],
      setup: ["RUN corepack enable"],
      install: "pnpm install --frozen-lockfile",
      run: (s) => `pnpm run ${s}`,
    };
  }
  if (has(dir, "yarn.lock")) {
    const berry = has(dir, ".yarnrc.yml");
    return {
      manifests: ["package.json", "yarn.lock", ...(berry ? [".yarnrc.yml"] : [])],
      setup: berry ? ["RUN corepack enable"] : [],
      install: berry ? "yarn install --immutable" : "yarn install --frozen-lockfile",
      run: (s) => `yarn run ${s}`,
    };
  }
  const lock = has(dir, "package-lock.json");
  return {
    manifests: ["package.json", ...(lock ? ["package-lock.json"] : []), ...(has(dir, ".npmrc") ? [".npmrc"] : [])],
    setup: [],
    install: lock ? "npm ci" : "npm install",
    run: (s) => `npm run ${s}`,
  };
}

function planNode(dir: string, site: SiteBuildSettings, notes: string[]): BuildPlan {
  const pkg = readPackageJson(dir);
  const scripts = pkg.scripts || {};
  const version = nodeVersion(pkg, site.nodeVersion);
  const pm = nodeInstall(dir);
  const port = validPort(site.port) ?? 3000;

  const build = site.buildCommand || (scripts.build ? pm.run("build") : null);
  let start = site.startCommand || procfileWeb(dir);
  if (!start) {
    if (scripts.start) start = "npm start";
    else {
      const entry = [pkg.main, "server.js", "index.js", "app.js", "main.js"].find((f) => f && has(dir, f));
      if (!entry) {
        throw new Error(
          'Could not work out how to start this Node.js app: package.json has no "start" script and no server.js/index.js was found. Set a start command on the site.'
        );
      }
      start = `node ${entry}`;
    }
  }
  notes.push(`Node.js ${version}, install: ${pm.install}${build ? `, build: ${build}` : ""}, start: ${start}`);

  const dockerfile = [
    `FROM node:${version}-alpine`,
    ...pm.setup,
    "WORKDIR /app",
    "RUN chown node:node /app",
    "USER node",
    `COPY --chown=node:node ${pm.manifests.join(" ")} ./`,
    // devDependencies are needed to build, so NODE_ENV=production is only set afterwards
    `RUN ${pm.install}`,
    "COPY --chown=node:node . .",
    ...(build ? [`RUN ${sh(build)}`] : []),
    "ENV NODE_ENV=production",
    `ENV PORT=${port}`,
    "ENV HOST=0.0.0.0",
    `EXPOSE ${port}`,
    `CMD ${sh(start)}`,
    "",
  ].join("\n");

  return { runtime: "node", port, dockerfilePath: GENERATED_DOCKERFILE, dockerfile, notes };
}

const NGINX_SPA_CONF =
  "server { listen 80; root /usr/share/nginx/html; index index.html; " +
  "location / { try_files $uri $uri/ $uri.html /index.html; } }";
const NGINX_STATIC_CONF =
  "server { listen 80; root /usr/share/nginx/html; index index.html index.htm; " +
  "location / { try_files $uri $uri/ $uri.html =404; } }";

function planNodeStatic(dir: string, site: SiteBuildSettings, notes: string[]): BuildPlan {
  const pkg = readPackageJson(dir);
  const version = nodeVersion(pkg, site.nodeVersion);
  const pm = nodeInstall(dir);
  const build = site.buildCommand || pm.run("build");
  notes.push(`Static front-end build (Node.js ${version}): ${pm.install} && ${build}, served by nginx`);

  const collect =
    `set -e; mkdir -p /out; for d in ${STATIC_OUTPUT_DIRS.join(" ")}; do ` +
    `if [ -f "$d/index.html" ]; then cp -a "$d"/. /out/; exit 0; fi; done; ` +
    `echo "Build finished but no output directory with an index.html was found (looked in: ${STATIC_OUTPUT_DIRS.join(", ")})"; exit 1`;

  const dockerfile = [
    `FROM node:${version}-alpine AS build`,
    ...pm.setup,
    "WORKDIR /app",
    `COPY ${pm.manifests.join(" ")} ./`,
    `RUN ${pm.install}`,
    "COPY . .",
    `RUN ${sh(build)}`,
    `RUN ${sh(collect)}`,
    "",
    "FROM nginx:alpine",
    `RUN ${sh(`echo '${NGINX_SPA_CONF}' > /etc/nginx/conf.d/default.conf`)}`,
    "COPY --from=build /out /usr/share/nginx/html",
    "EXPOSE 80",
    "",
  ].join("\n");

  return { runtime: "node-static", port: 80, dockerfilePath: GENERATED_DOCKERFILE, dockerfile, notes };
}

function planStatic(dir: string, notes: string[]): BuildPlan {
  let root = ".";
  if (!has(dir, "index.html")) {
    const sub = STATIC_OUTPUT_DIRS.find((d) => has(dir, d, "index.html"));
    if (!sub) throw new Error("Static site has no index.html (looked in the project root and common output folders).");
    root = sub;
  }
  notes.push(`Static site served by nginx from ${root === "." ? "the project root" : root + "/"}`);

  const dockerfile = [
    "FROM nginx:alpine",
    `RUN ${sh(`echo '${NGINX_STATIC_CONF}' > /etc/nginx/conf.d/default.conf`)}`,
    `COPY ${root === "." ? "." : root + "/"} /usr/share/nginx/html/`,
    `RUN rm -f /usr/share/nginx/html/${GENERATED_DOCKERFILE} /usr/share/nginx/html/Dockerfile`,
    "EXPOSE 80",
    "",
  ].join("\n");

  return { runtime: "static", port: 80, dockerfilePath: GENERATED_DOCKERFILE, dockerfile, notes };
}

function pythonStart(dir: string): string {
  const reqs = (read(dir, "requirements.txt") + "\n" + read(dir, "pyproject.toml") + "\n" + read(dir, "Pipfile")).toLowerCase();
  const moduleFile = ["main.py", "app.py", "server.py", "wsgi.py", "asgi.py"].find((f) => has(dir, f));
  const mod = moduleFile ? moduleFile.replace(/\.py$/, "") : "app";

  if (has(dir, "manage.py")) {
    const wsgiDir = fs
      .readdirSync(dir, { withFileTypes: true })
      .find((e) => e.isDirectory() && has(dir, e.name, "wsgi.py"))?.name;
    if (wsgiDir && reqs.includes("gunicorn")) return `gunicorn ${wsgiDir}.wsgi --bind 0.0.0.0:$PORT`;
    return "python manage.py runserver 0.0.0.0:$PORT";
  }
  if (reqs.includes("uvicorn") || reqs.includes("fastapi")) return `uvicorn ${mod}:app --host 0.0.0.0 --port $PORT`;
  if (reqs.includes("gunicorn")) return `gunicorn --bind 0.0.0.0:$PORT ${mod}:app`;
  if (reqs.includes("streamlit") && moduleFile) return `streamlit run ${moduleFile} --server.port $PORT --server.address 0.0.0.0`;
  if (reqs.includes("flask")) return `flask --app ${mod} run --host 0.0.0.0 --port $PORT`;
  if (moduleFile) return `python ${moduleFile}`;
  throw new Error("Could not work out how to start this Python app. Add a Procfile with a web: line, or set a start command on the site.");
}

function planPython(dir: string, site: SiteBuildSettings, notes: string[]): BuildPlan {
  const port = validPort(site.port) ?? 8000;
  const start = site.startCommand || procfileWeb(dir) || pythonStart(dir);
  const hasReqs = has(dir, "requirements.txt");
  notes.push(`Python 3.12, install: ${hasReqs ? "pip install -r requirements.txt" : "pip install ."}, start: ${start}`);

  const dockerfile = [
    "FROM python:3.12-slim",
    "ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1",
    "WORKDIR /app",
    ...(hasReqs
      ? ["COPY requirements.txt ./", "RUN pip install -r requirements.txt", "COPY . ."]
      : ["COPY . .", "RUN pip install ."]),
    ...(site.buildCommand ? [`RUN ${sh(site.buildCommand)}`] : []),
    "RUN useradd --create-home --uid 10001 app && chown -R app:app /app",
    "USER app",
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    `CMD ${sh(start)}`,
    "",
  ].join("\n");

  return { runtime: "python", port, dockerfilePath: GENERATED_DOCKERFILE, dockerfile, notes };
}

function planPhp(dir: string, site: SiteBuildSettings, notes: string[]): BuildPlan {
  const version = /^\d\.\d$/.test(site.phpVersion || "") ? site.phpVersion : "8.3";
  const composer = has(dir, "composer.json");
  const publicRoot = !has(dir, "index.php") && has(dir, "public", "index.php");
  notes.push(`PHP ${version} on Apache${composer ? ", composer install" : ""}${publicRoot ? ", document root: public/" : ""}`);

  const dockerfile = [
    `FROM php:${version}-apache`,
    "RUN a2enmod rewrite",
    ...(composer
      ? [
          "RUN apt-get update && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/*",
          "COPY --from=composer:2 /usr/bin/composer /usr/bin/composer",
        ]
      : []),
    "WORKDIR /var/www/html",
    "COPY . /var/www/html/",
    ...(composer ? ["RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader"] : []),
    ...(site.buildCommand ? [`RUN ${sh(site.buildCommand)}`] : []),
    ...(publicRoot
      ? [
          `RUN ${sh(
            "sed -ri 's!/var/www/html!/var/www/html/public!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf"
          )}`,
        ]
      : []),
    `RUN rm -f /var/www/html/${GENERATED_DOCKERFILE} && chown -R www-data:www-data /var/www/html`,
    "EXPOSE 80",
    "",
  ].join("\n");

  return { runtime: "php", port: 80, dockerfilePath: GENERATED_DOCKERFILE, dockerfile, notes };
}

function planGo(dir: string, site: SiteBuildSettings, notes: string[]): BuildPlan {
  const port = validPort(site.port) ?? 8080;
  const m = read(dir, "go.mod").match(/^go\s+(\d+\.\d+)/m);
  const version = m ? m[1] : "1.23";
  notes.push(`Go ${version}, static binary on Alpine`);

  const dockerfile = [
    `FROM golang:${version}-alpine AS build`,
    "WORKDIR /src",
    "COPY . .",
    `RUN ${sh(site.buildCommand || "CGO_ENABLED=0 go build -o /out/app .")}`,
    "",
    "FROM alpine:3.20",
    "RUN apk add --no-cache ca-certificates",
    "COPY --from=build /out/app /app",
    "USER nobody",
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    site.startCommand ? `CMD ${sh(site.startCommand)}` : 'CMD ["/app"]',
    "",
  ].join("\n");

  return { runtime: "go", port, dockerfilePath: GENERATED_DOCKERFILE, dockerfile, notes };
}

/** Last EXPOSE of the Dockerfile's final stage, which is the port the image serves on. */
export function exposedPort(dockerfileText: string): number | null {
  const lines = dockerfileText.split(/\r?\n/);
  let lastFrom = 0;
  lines.forEach((l, i) => {
    if (/^\s*FROM\s/i.test(l)) lastFrom = i;
  });
  let port: number | null = null;
  for (const l of lines.slice(lastFrom)) {
    const m = l.match(/^\s*EXPOSE\s+(\d{1,5})/i);
    if (m) port = Number(m[1]);
  }
  return port;
}

function planDocker(dir: string, site: SiteBuildSettings, notes: string[]): BuildPlan {
  if (!has(dir, "Dockerfile")) throw new Error("No Dockerfile found in the project root for a Docker deployment.");
  const exposed = exposedPort(read(dir, "Dockerfile"));
  // EXPOSE wins: the Dockerfile is the source of truth, and a wrong port is caught (and asked about) at the health check.
  const port = exposed ?? validPort(site.port) ?? 80;
  notes.push(
    `Using the repository's Dockerfile (serving on port ${port}${exposed ? ", taken from EXPOSE" : validPort(site.port) ? ", set on the app" : ", no EXPOSE so assuming 80"})`
  );
  return { runtime: "docker", port, dockerfilePath: "Dockerfile", dockerfile: null, notes };
}

/**
 * Decides how to build a site. `type` is what the user picked; "auto" (the
 * default) means work it out from the files that are actually there.
 */
export function createBuildPlan(dir: string, site: SiteBuildSettings): BuildPlan {
  const notes: string[] = [];
  let runtime: string | null = site.type;

  if (!runtime || runtime === "auto") {
    runtime = detectRuntime(dir);
    if (!runtime) {
      throw new Error(
        "Could not detect what kind of project this is. Expected one of: Dockerfile, package.json, requirements.txt/pyproject.toml, go.mod, composer.json/index.php, or index.html."
      );
    }
    notes.push(`Auto-detected runtime: ${runtime}`);
  } else if (runtime === "node" && has(dir, "package.json") && isStaticNodeBuild(dir, site.startCommand)) {
    // A Vite/CRA/Astro-style project picked as "Node.js" has nothing to `npm start`; build and serve it instead.
    runtime = "node-static";
    notes.push('No "start" script but a front-end build was found: building static files and serving them with nginx');
  }

  switch (runtime) {
    case "docker":
      return planDocker(dir, site, notes);
    case "node":
      if (!has(dir, "package.json")) throw new Error("Node.js site has no package.json in the project root.");
      return planNode(dir, site, notes);
    case "node-static":
      return planNodeStatic(dir, site, notes);
    case "python":
      return planPython(dir, site, notes);
    case "php":
      return planPhp(dir, site, notes);
    case "go":
      if (!has(dir, "go.mod")) throw new Error("Go site has no go.mod in the project root.");
      return planGo(dir, site, notes);
    case "static":
      return planStatic(dir, notes);
    default:
      throw new Error(`Unsupported runtime: ${runtime}`);
  }
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

/**
 * Extra `git` arguments that authenticate an HTTPS clone with a token, without
 * putting the token in the URL (where it would end up in logs, error messages
 * and .git/config). The header is scoped to the repository's host, so it is
 * never sent anywhere else.
 */
export function gitAuthArgs(repoUrl: string, token?: string | null): string[] {
  if (!token) return [];
  let origin: string;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:") return [];
    origin = `${u.protocol}//${u.host}/`;
  } catch {
    return [];
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.${origin}.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** Removes a token (and its base64 form) from text before it is logged or returned. */
export function redactToken(text: string, token?: string | null): string {
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("***").split(basic).join("***");
}

/** Lowercase, dash-separated name usable as a subdomain label. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\.git$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "app"
  );
}

export * from "./analyze";
