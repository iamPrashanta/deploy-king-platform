// panel routes, project check on real repos, and a deploy that pauses for an answer
import { call, login, pass, viaTraefik, PW } from "./lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n== sign in (first login must change the seeded password)");
let r = await login("admin", PW);
if (!r?.token) {
  r = await login("admin", "Initial-Passw0rd-1");
  pass(!!r?.user?.mustChangePassword, "seeded admin must change password");
  await call("m", "auth.changePassword", { newPassword: PW });
  r = await login("admin", PW);
}
pass(!!r?.token, "signed in");

console.log("\n== panel routes (production build on :3000)");
for (const p of ["/login", "/", "/apps", "/apps/new", "/templates", "/backup-cli", "/settings", "/setup/password"]) {
  const res = await fetch("http://localhost:3000" + p, { redirect: "manual" });
  const html = await res.text();
  pass(res.status === 200 && html.includes('data-theme="dark"'), `GET ${p}`, String(res.status));
}
const red = await fetch("http://localhost:3000/sites", { redirect: "manual" });
pass([307, 308].includes(red.status) && (red.headers.get("location") || "").endsWith("/apps"), "/sites redirects to /apps", red.status + " " + red.headers.get("location"));

console.log("\n== project check on real repositories");
for (const [url, want] of [
  ["https://github.com/iamPrashanta/dbbkp.git", "not-deployable"],
  ["https://github.com/heroku/node-js-getting-started.git", null],
]) {
  const b = await call("q", "git.branches", { repoUrl: url });
  const res = await call("m", "git.inspect", { repoUrl: url, branch: b?.defaultBranch || "main" });
  const rep = res?.report;
  pass(!!rep && (want ? rep.verdict === want : rep.verdict !== "not-deployable"), `${url.split("/").slice(-1)[0]}: ${rep?.verdict}`, rep?.summary);
  if (rep) console.log("      facts:", rep.facts.map((f) => `${f.label}=${f.value}`).join("; "));
}

console.log("\n== deploy that pauses: image listens on 80, app set to 3000");
const sites = await call("q", "sites.list");
for (const s of sites.filter((s) => ["whoami.localhost", "hello.localhost"].includes(s.domain))) await call("m", "sites.delete", { id: s.id });
await sleep(4000);
const site = await call("m", "sites.create", { domain: "whoami.localhost", source: "image", runtime: "image", image: "traefik/whoami:latest", port: 3000, env: [], volumes: [] });
pass(!!site?.id, "created whoami with the wrong port");
let dep, prompt;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
  if (dep?.status === "waiting_input" || dep?.status === "failed" || dep?.status === "active") break;
}
pass(dep?.status === "waiting_input", "deploy is waiting for an answer", dep?.status);
const full = await call("q", "sites.deployment", { deploymentId: dep.id });
prompt = full?.prompt;
pass(!!prompt && prompt.options?.some((o) => o.value === "80"), "asks to use port 80", prompt?.title);
const bad = await call("m", "sites.answer", { deploymentId: dep.id, promptId: prompt.id, value: "9999" }, true);
pass(bad?.error === "BAD_REQUEST", "an answer that was not offered is rejected");
await call("m", "sites.answer", { deploymentId: dep.id, promptId: prompt.id, value: "80" });
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
  if (dep?.status === "active" || dep?.status === "failed") break;
}
pass(dep?.status === "active", "deploy finished after the answer", dep?.status + (dep?.error ? " " + dep.error.slice(0, 120) : ""));
const after = await call("q", "sites.get", { id: site.id });
pass(after?.port === 80, "the chosen port is remembered on the app", String(after?.port));
const web = await viaTraefik("whoami.localhost");
pass(web.status === 200 && /Hostname/i.test(web.snippet), "whoami.localhost answers through Traefik", web.status + " " + web.snippet);

console.log("\n== template deploy: nginx");
const n = await call("m", "sites.create", { domain: "hello.localhost", source: "image", runtime: "image", image: "nginx:alpine", port: 80, env: [], volumes: [] });
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  dep = (await call("q", "sites.deployments", { id: n.id }))?.[0];
  if (dep?.status === "active" || dep?.status === "failed") break;
}
pass(dep?.status === "active", "nginx template is live", dep?.status);
const w2 = await viaTraefik("hello.localhost");
pass(w2.status === 200 && /nginx/i.test(w2.snippet), "hello.localhost serves the nginx page", w2.snippet);
const ov = await call("q", "system.overview");
pass(ov?.apps?.total >= 2, "overview counts the apps", JSON.stringify(ov?.apps));
