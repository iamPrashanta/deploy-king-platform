// workflows: private addresses are for admins only; redirects are checked hop by hop
import { call, login, pass, setToken, getToken } from "/t/lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runHttp(name, url, extra = {}) {
  const a = await call("m", "automations.create", { name });
  await call("m", "automations.update", {
    id: a.id,
    graph: {
      nodes: [
        { id: "t", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
        { id: "h", type: "action.http", position: { x: 200, y: 0 }, data: { url, ...extra } },
      ],
      edges: [{ id: "t-out-h", source: "t", target: "h", sourceHandle: null }],
    },
  });
  const { runId } = await call("m", "automations.execute", { id: a.id });
  let r;
  for (let i = 0; i < 40; i++) {
    r = await call("q", "automations.run", { runId });
    if (r && !["queued", "running"].includes(r.status)) break;
    await sleep(700);
  }
  await call("m", "automations.delete", { id: a.id });
  return r.steps.h;
}

await login();
const admin = getToken();
let s = await runHttp("admin internal", "http://localhost:4000/health");
pass(s.status === "success", "admin may call an internal address", s.status + " " + (s.error ?? ""));
s = await runHttp("admin metadata", "http://169.254.169.254/latest/meta-data/");
pass(s.status === "failed" && /metadata/.test(s.error), "metadata address blocked even for admins", s.error);

const bob = await login("bob", "Bob-Passw0rd-12345");
pass(!!bob?.token, "signed in as a non-admin user");
for (const [label, url] of [
  ["loopback name", "http://localhost:4000/health"],
  ["loopback IP", "http://127.0.0.1:4000/health"],
  ["container name (database)", "http://dbbkp-check-pg:5432/"],
  ["private range", "http://10.89.7.10:4000/health"],
  ["IPv6 loopback", "http://[::1]:4000/health"],
  ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]:4000/health"],
]) {
  s = await runHttp("bob " + label, url);
  pass(s.status === "failed" && /private or internal/.test(s.error ?? ""), "non-admin blocked: " + label, s.error ?? s.status);
}
s = await runHttp("bob public", "https://example.com/");
pass(s.status === "success" && s.output?.status === 200, "non-admin may call a public URL", s.status + " " + (s.error ?? s.output?.status));
setToken(admin);
// a redirect is checked like the first URL: an allowed address that bounces to a blocked one is refused
const http = await import("node:http");
const srv = http.createServer((_q, res) => { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); }).listen(4999);
s = await runHttp("admin redirect", "http://localhost:4999/go");
pass(s.status === "failed" && /metadata/.test(s.error ?? ""), "redirect to a blocked address is refused", s.error ?? JSON.stringify(s.output).slice(0, 100));
srv.close();
