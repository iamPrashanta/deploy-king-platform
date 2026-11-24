// shared helpers for the end-to-end checks
import fs from "node:fs";
export const B = "http://localhost:4000";
export const PW = "Check-Passw0rd-12345";
let token = null;
export const setToken = (t) => { token = t; };
export const getToken = () => token;
export async function call(kind, path, input, quiet) {
  const h = { "content-type": "application/json" };
  if (token) h.authorization = "Bearer " + token;
  const r = kind === "q"
    ? await fetch(B + "/trpc/" + path + (input === undefined ? "" : "?input=" + encodeURIComponent(JSON.stringify(input))), { headers: h })
    : await fetch(B + "/trpc/" + path, { method: "POST", headers: h, body: JSON.stringify(input ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (j.error) {
    if (!quiet) console.log("  [" + r.status + "] " + path + " -> " + j.error.data?.code + ": " + String(j.error.message).slice(0, 160));
    return { error: j.error.data?.code, message: j.error.message, status: r.status };
  }
  return j.result ? j.result.data : null;
}
export async function login(username = "admin", password = PW) {
  const d = await call("m", "auth.login", { username, password });
  if (d?.token) token = d.token;
  return d;
}
export async function upload(domain, type, zipPath) {
  const fd = new FormData();
  fd.append("project", new Blob([fs.readFileSync(zipPath)]), "project.zip");
  fd.append("domain", domain);
  fd.append("type", type);
  const r = await fetch(B + "/api/sites/upload", { method: "POST", headers: token ? { authorization: "Bearer " + token } : {}, body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
export async function waitDeploys(timeoutMs = 420000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const sites = await call("q", "sites.list");
    const busy = sites.filter((s) => s.status === "provisioning");
    if (busy.length === 0 || Date.now() > end) return sites;
    await new Promise((r) => setTimeout(r, 4000));
  }
}
import http from "node:http";
// fetch() refuses to override the Host header, so talk to Traefik with node:http
export function viaTraefik(domain, path = "/") {
  return new Promise((resolve) => {
    const req = http.request({ host: "dbbkp-check-traefik", port: 80, path, headers: { host: domain }, timeout: 8000 }, (res) => {
      let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, snippet: text.replace(/\s+/g, " ").slice(0, 70) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, snippet: String(e.code || e.message) }));
    req.end();
  });
}
export const pass = (ok, label, extra = "") => console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));