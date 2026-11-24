import { call, login, upload, waitDeploys, viaTraefik, pass, PW } from "./lib.mjs";
// 1. auth
let d = await call("m", "auth.login", { username: "admin", password: "Initial-Passw0rd-1" });
const { setToken } = await import("./lib.mjs"); setToken(d.token);
let r = await call("q", "sites.list", undefined, true);
pass(r?.error === "FORBIDDEN", "password rotation enforced before anything else");
await call("m", "auth.changePassword", { newPassword: PW });
await login();
// 2. validation
r = await call("m", "sites.create", { domain: "bad`domain) || Host(`x", runtime: "auto", source: "git", repoUrl: "https://github.com/a/b.git" }, true);
pass(r?.error === "BAD_REQUEST", "hostile domain rejected");
r = await call("m", "sites.create", { domain: "x.test.local", runtime: "auto", source: "git", repoUrl: "--upload-pack=touch /tmp/pwned" }, true);
pass(r?.error === "BAD_REQUEST", "option-injection repo URL rejected");
r = await call("m", "sites.create", { domain: "x.test.local", runtime: "auto", source: "git", repoUrl: "file:///etc" }, true);
pass(r?.error === "BAD_REQUEST", "file:// repo URL rejected");
// 3. git sites, all on runtime=auto
const git = [
  ["node.test.local", "https://github.com/heroku/node-js-getting-started.git", "main"],
  ["static.test.local", "https://github.com/cloudacademy/static-website-example.git", "master"],
  ["docker.test.local", "https://github.com/crccheck/docker-hello-world.git", "master"],
  ["php.test.local", "https://github.com/banago/simple-php-website.git", "master"],
  ["python.test.local", "https://github.com/render-examples/flask-hello-world.git", "master"],
];
for (const [domain, repoUrl, branch] of git) {
  r = await call("m", "sites.create", { domain, runtime: "auto", source: "git", repoUrl, branch });
  if (r?.error) pass(false, "create " + domain, r.message);
}
// 4. zip sites
for (const [domain, zip] of [["vite.test.local", "/tmp/z/vite.zip"], ["go.test.local", "/tmp/z/go.zip"], ["broken.test.local", "/tmp/z/broken.zip"]]) {
  const u = await upload(domain, "auto", zip);
  if (u.status !== 200) pass(false, "upload " + domain, JSON.stringify(u.body));
}
r = await call("m", "sites.create", { domain: "node.test.local", runtime: "auto", source: "git", repoUrl: "https://github.com/a/b.git" }, true);
pass(r?.error === "CONFLICT", "duplicate domain rejected");
console.log("deploying 8 sites...");
const sites = await waitDeploys();
for (const s of sites.reverse()) {
  const deps = await call("q", "sites.deployments", { id: s.id });
  const dep = deps[0];
  const web = s.status === "active" ? await viaTraefik(s.domain) : { status: "-", snippet: "" };
  const expectFail = s.domain.startsWith("broken");
  const ok = expectFail ? (s.status === "failed" && dep.status === "failed") : (s.status === "active" && web.status === 200);
  pass(ok, s.domain.padEnd(20) + " site=" + s.status.padEnd(7) + " deploy=" + dep.status.padEnd(7) + " runtime=" + String(dep.runtime).padEnd(11) + " port=" + String(s.port).padEnd(5) + " http=" + web.status + " " + Math.round((dep.durationMs || 0) / 1000) + "s", expectFail ? String(dep.error).split("\n")[0].slice(0, 110) : web.snippet);
  if (!ok && !expectFail) console.log("      error: " + String(dep.error).slice(0, 600));
}