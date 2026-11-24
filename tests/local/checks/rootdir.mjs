// root directory (build an app from a subfolder) and build-time variables
import { execSync } from "node:child_process";
import fs from "node:fs";
import { call, login, upload, pass, viaTraefik } from "/t/lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login();

// a repository with two apps and nothing deployable at its root
const R = "/tmp/z/mono";
fs.rmSync(R, { recursive: true, force: true });
fs.mkdirSync(`${R}/apps/web/stub`, { recursive: true });
fs.mkdirSync(`${R}/apps/api`, { recursive: true });
fs.writeFileSync(`${R}/README.md`, "# two apps\n");
fs.writeFileSync(`${R}/apps/web/package.json`, JSON.stringify({ name: "web", private: true, scripts: { build: "node build.js" }, devDependencies: { vite: "file:./stub" } }));
fs.writeFileSync(`${R}/apps/web/stub/package.json`, JSON.stringify({ name: "vite", version: "0.0.0" }));
fs.writeFileSync(
  `${R}/apps/web/build.js`,
  `const fs = require("fs"); fs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/index.html", "<h1>greeting=" + process.env.VITE_GREETING + " runtime=" + (process.env.RUNTIME_ONLY || "none") + "</h1>");\n`
);
fs.writeFileSync(`${R}/apps/api/package.json`, JSON.stringify({ name: "api", private: true, scripts: { start: "node index.js" } }));
fs.writeFileSync(`${R}/apps/api/index.js`, "require('http').createServer((q, s) => s.end('api')).listen(process.env.PORT || 3000);\n");
execSync(`cd ${R} && rm -f ../mono.zip && zip -qr ../mono.zip .`);

const site = async () => (await call("q", "sites.list")).find((s) => s.domain === "mono.localhost");
const settle = async () => { let s; for (let i = 0; i < 80; i++) { await sleep(3000); s = await site(); if (s && s.status !== "provisioning") break; } return s; };
const lastDeploy = async (id) => { const [d] = await call("q", "sites.deployments", { id, limit: 1 }); return call("q", "sites.deployment", { deploymentId: d.id }); };

const u = await upload("mono.localhost", "auto", "/tmp/z/mono.zip");
pass(u.status === 200, "uploaded a repository with two app folders");
let s = await settle();
let d = await lastDeploy(s.id);
pass(s.status === "failed", "building the repository root fails: there is no app there", (d.error || "").split("\n")[0].slice(0, 110));

let r = await call("m", "sites.update", { id: s.id, rootDirectory: "../../etc" }, true);
pass(r?.error === "BAD_REQUEST", "a root directory outside the repository is refused", r?.message);
r = await call("m", "sites.update", { id: s.id, rootDirectory: "/apps/web/" });
pass(r?.rootDirectory === "apps/web", "root directory saved (slashes cleaned)", r?.rootDirectory);

await call("m", "sites.envSetMany", { id: s.id, vars: [{ key: "VITE_GREETING", value: "hello-from-build", buildTime: true }, { key: "RUNTIME_ONLY", value: "not-for-the-build" }] });
let env = await call("q", "sites.envList", { id: s.id });
pass(env.find((v) => v.key === "VITE_GREETING")?.buildTime === true && env.find((v) => v.key === "RUNTIME_ONLY")?.buildTime === false, "variables keep their build flag", JSON.stringify(env.map((v) => [v.key, v.buildTime])));

await call("m", "sites.redeploy", { id: s.id });
s = await settle();
d = await lastDeploy(s.id);
pass(s.status === "active", "the app in apps/web deploys", s.status + " " + (d.error || "").split("\n")[0].slice(0, 120));
pass(/Building from the folder apps\/web/.test(d.log) && /Build-time variables: VITE_GREETING/.test(d.log), "the deploy log says which folder and which build variables");
pass(!d.log.includes("hello-from-build") && !d.log.includes("not-for-the-build"), "no variable value appears in the deploy log");
await sleep(2500);
const page = await viaTraefik("mono.localhost");
pass(page.status === 200 && /greeting=hello-from-build runtime=none/.test(page.snippet), "the build saw the build-time variable and not the runtime-only one", page.snippet);

r = await call("m", "sites.envSetBuildTime", { id: s.id, key: "VITE_GREETING", buildTime: false });
env = await call("q", "sites.envList", { id: s.id });
pass(r?.success && env.find((v) => v.key === "VITE_GREETING")?.buildTime === false, "the build flag can be switched without re-entering the value");

await call("m", "sites.update", { id: s.id, rootDirectory: "apps/missing" });
await call("m", "sites.redeploy", { id: s.id });
s = await settle();
d = await lastDeploy(s.id);
pass(d.status === "failed" && /no folder "apps\/missing"/.test(d.error || ""), "a missing folder fails with a clear message", (d.error || "").slice(0, 90));
const still = await viaTraefik("mono.localhost");
pass(still.status === 200, "the previous release keeps serving after that failed deploy", String(still.status));
await call("m", "sites.delete", { id: s.id });

// project check on a real multi-app repository
r = await call("m", "git.inspect", { repoUrl: "https://github.com/docker/awesome-compose", branch: "master" });
pass(Array.isArray(r?.folders) && r.folders.includes("apache-php/app"), "the check lists app folders", `${r?.folders?.length} folders, e.g. ${r?.folders?.slice(0, 4).join(", ")}`);
r = await call("m", "git.inspect", { repoUrl: "https://github.com/docker/awesome-compose", branch: "master", rootDirectory: "apache-php/app" });
pass(r?.rootDirectory === "apache-php/app" && r.report?.runtime === "docker", "the check looks inside the chosen folder", `${r?.report?.verdict} · ${r?.report?.runtime} · port ${r?.report?.port}`);
r = await call("m", "git.inspect", { repoUrl: "https://github.com/docker/awesome-compose", branch: "master", rootDirectory: "nope/nothing" }, true);
pass(r?.error === "BAD_REQUEST" && /no folder/.test(r.message), "checking a folder that is not there says so", r?.message);
console.log("done");
