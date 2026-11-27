// The assistant (dk and the desktop app) against the real API, in a real EMPTY database (run by freshdb.sh):
// the MCP tools it added (scheduled jobs, workers, databases, set_env replaceAll, who the token is), the ZIP
// upload for agent tokens (POST /mcp/upload), and one whole conversation of @dbbkp/assistant with a scripted
// model (no AI is called) that deploys an attached folder.
// The job queues are replaced by in-memory stand-ins, so neither Redis nor a container engine is needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

async function main() {
  const root = process.cwd(); // apps/api
  // Packages are resolved from the API, so this file may live anywhere (/t in the test container).
  const req = createRequire(root + "/package.json");
  const pkg = (name: string) => import(req.resolve(name));
  // CHECK_TMP: another place for the apps' folders, when the temp disk looks full to the capacity check.
  const sitesRoot = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), "dk-assistantflow-"));
  process.env.SITES_ROOT = sitesRoot;
  process.env.MASTER_KEY ||= "11".repeat(32); // test key, for a run outside the test container
  process.env.DBBKP_BASE_DOMAIN = "localhost";

  const queues = await import(root + "/src/queues");
  const added: Array<{ queue: string; name: string; data: any }> = [];
  for (const [queue, q] of Object.entries(queues) as Array<[string, any]>) {
    if (!q || typeof q.add !== "function") continue;
    q.on?.("error", () => {}); // no Redis here
    Object.assign(q, {
      add: async (name: string, data: any) => (added.push({ queue, name, data }), {}),
      getRepeatableJobs: async () => [],
      removeRepeatableByKey: async () => true,
    });
  }

  const express = (await pkg("express")).default;
  const mcpRouter = (await import(root + "/src/routes/mcp")).default;
  const { db, users, sites, siteAccess, apiTokens, siteEnvVars, mcpCalls, deployments } = await pkg("@dbbkp/db");
  const { eq } = await pkg("drizzle-orm");
  const { newToken } = await import(root + "/src/services/apiTokens");
  const bcrypt = (await pkg("bcryptjs")).default;
  const AdmZip = (await import(createRequire(root + "/../../packages/assistant/package.json").resolve("adm-zip"))).default;
  const A = await import(root + "/../../packages/assistant/src/index");

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
  };

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/mcp", mcpRouter);
  const server = await new Promise<any>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (username: string, role: string, extra: any = {}) =>
    (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role, ...extra }).returning())[0];
  const token = async (u: any, scope: string) => {
    const t = newToken();
    await db.insert(apiTokens).values({ userId: u.id, name: `${u.username}-${scope}`, scope, tokenHash: t.hash, prefix: t.prefix });
    return new A.HttpDkApi(base, t.raw);
  };
  const ownerRow = await mk("owner", "admin", { teamRole: "admin" });
  const devRow = await mk("dev", "user", { teamRole: "developer" });
  const site = async (domain: string) =>
    (await db.insert(sites).values({ userId: ownerRow.id, domain, type: "node", docRoot: `${sitesRoot}/x`, source: "image", image: "x:y", status: "active", currentTag: "dbbkp-site-x:1", port: 3000 }).returning())[0];
  const shop = await site("shop.localhost"), other = await site("other.localhost");
  await db.insert(siteAccess).values({ siteId: shop.id, userId: devRow.id });
  const owner = await token(ownerRow, "deploy"), dev = await token(devRow, "deploy"), devRead = await token(devRow, "read");
  const data = (r: any) => (r.ok ? r.data : { error: r.error });

  // ── who the token is ──
  const st: any = data(await dev.callTool("platform_status", {}));
  pass(st.you?.username === "dev" && st.you?.role === "user", "platform_status says who the token acts as (dk's header and dk login)", JSON.stringify(st.you));

  // ── scheduled jobs ──
  const job = { app: "shop", name: "Daily report", command: "node scripts/report.js", schedule: "0 6 * * *", timezone: "Asia/Kolkata" };
  const refused = await devRead.callTool("add_scheduled_job", job);
  pass(!refused.ok && /deploy/i.test((refused as any).error), "a read token cannot add a scheduled job", (refused as any).error);
  const j: any = data(await dev.callTool("add_scheduled_job", job));
  pass(j.job?.words === "Every day at 06:00" && j.job?.timezone === "Asia/Kolkata" && j.app === "shop.localhost", "add_scheduled_job adds a job, named by the app's short name, in its time zone", JSON.stringify(j));
  const jl: any = data(await devRead.callTool("list_scheduled_jobs", { app: "shop" }));
  pass(jl.jobs?.length === 1 && jl.jobs[0].command === job.command && jl.jobs[0].active === true, "list_scheduled_jobs shows it to a read token", JSON.stringify(jl));
  const hidden = await dev.callTool("add_scheduled_job", { ...job, app: "other" });
  pass(!hidden.ok, "an app that was not shared with the token's user cannot get a job", (hidden as any).error);

  // ── workers ──
  const w: any = data(await dev.callTool("add_worker", { app: "shop", name: "emails", command: "node dist/worker.js", memoryMb: 128 }));
  pass(w.worker?.name === "emails" && w.worker?.memoryMb === 128 && added.some((a) => a.name === "sync-workers" && a.data.siteId === shop.id), "add_worker adds a worker and asks the worker to start it", JSON.stringify(w));
  const wl: any = data(await devRead.callTool("list_workers", { app: "shop" }));
  pass(wl.workers?.length === 1 && wl.workers[0].command === "node dist/worker.js", "list_workers shows it", JSON.stringify(wl));

  // ── databases ──
  const d: any = data(await owner.callTool("create_database", { app: "shop", name: "shop_api" }));
  const job0 = added.find((a) => a.name === "create-postgres");
  const pw = job0?.data?.dbPass;
  pass(d.database?.name === "shop_api" && d.variable === "DATABASE_URL" && !!pw && job0.data.dbName === "shop_api", "create_database creates the database for the app and puts the URL in DATABASE_URL", JSON.stringify(d));
  const ga: any = data(await dev.callTool("get_app", { app: "shop" }));
  const calls = await db.select().from(mcpCalls);
  const envRows = await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, shop.id));
  pass(!JSON.stringify(d).includes(pw) && !JSON.stringify(ga).includes(pw) && !JSON.stringify(calls).includes(pw) && !JSON.stringify(envRows).includes(pw), "the database password is never returned, logged or stored in the clear");
  pass(JSON.stringify(ga).includes("DATABASE_URL"), "get_app lists the variable by name");
  const dl: any = data(await devRead.callTool("list_databases", {}));
  pass(dl.count === 1 && dl.databases[0].app === "shop.localhost" && !JSON.stringify(dl).includes(pw), "list_databases shows it with its app", JSON.stringify(dl));

  // ── set_env replaceAll ──
  await dev.callTool("set_env", { app: "shop", set: { A: "1", B: "2" } });
  const ra: any = data(await dev.callTool("set_env", { app: "shop", set: { A: "3", C: "4" }, replaceAll: true }));
  const names = (await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, shop.id))).map((r: any) => r.key).sort();
  pass(JSON.stringify(names) === JSON.stringify(["A", "C"]), "set_env with replaceAll makes set the complete list", JSON.stringify({ ra, names }));
  const empty = await dev.callTool("set_env", { app: "shop", replaceAll: true });
  pass(!empty.ok && /complete list/.test((empty as any).error), "replaceAll with nothing in set is refused, so it cannot wipe every variable", (empty as any).error);

  // ── POST /mcp/upload ──
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "dk-assistantflow-src-"));
  fs.mkdirSync(path.join(folder, "site"));
  fs.writeFileSync(path.join(folder, "site", "index.html"), "<h1>hello</h1>"); // one top folder: unwrapped on both sides
  const zip = A.prepareUpload(folder).zip;
  const noScope = await devRead.uploadZip({ zip, fileName: "site.zip", name: "site" });
  pass(!noScope.ok && /deploy/.test((noScope as any).error), "a read token cannot upload", (noScope as any).error);
  const noGrant = await dev.uploadZip({ zip, fileName: "site.zip", name: "site" });
  pass(!noGrant.ok, "a developer who may not create apps cannot upload one either", (noGrant as any).error);
  const before = added.length;
  const up: any = data(await owner.uploadZip({ zip, fileName: "site.zip", name: "site", variables: { API_KEY: "upload-secret-value-1234" } }));
  const [made] = up.id ? await db.select().from(sites).where(eq(sites.id, up.id)) : [];
  pass(up.name === "site.localhost" && up.deploymentId && made?.source === "zip", "an upload creates the app", JSON.stringify(up));
  pass(fs.existsSync(path.join(sitesRoot, String(up.id), "index.html")), "the ZIP is unpacked into the app's folder, its top folder unwrapped");
  pass(added.slice(before).some((a) => a.name === "deploy-site" && a.data.siteId === up.id) && (await db.select().from(deployments).where(eq(deployments.siteId, up.id))).length === 1, "and its first deploy is queued");
  const upEnv = up.id ? await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, up.id)) : [];
  await new Promise((r) => setTimeout(r, 300)); // the activity row is written after the answer
  const upCalls = await db.select().from(mcpCalls).where(eq(mcpCalls.tool, "upload_zip"));
  pass(upEnv.length === 1 && upEnv[0].key === "API_KEY" && !JSON.stringify(upEnv).includes("upload-secret-value-1234") && !JSON.stringify(upCalls).includes("upload-secret-value-1234"), "variables sent with the upload are stored encrypted and not logged");
  pass(upCalls.length === 2 && upCalls.filter((c: any) => c.ok).length === 1, "uploads are in the AI agents activity list, refused ones too (a token refused at the door is not)", String(upCalls.length));
  // adm-zip cleans names it writes, so the ../ is put into the bytes afterwards (same length, both headers).
  const bad = new AdmZip();
  bad.addFile("xx/evil.txt", Buffer.from("x"));
  const evilZip = Buffer.from(bad.toBuffer().toString("latin1").split("xx/evil.txt").join("../evil.txt"), "latin1");
  const evil = await owner.uploadZip({ zip: evilZip, fileName: "evil.zip", name: "evil" });
  const evilLeft = await db.select().from(sites).where(eq(sites.domain, "evil.localhost"));
  pass(!evil.ok && /unsafe|outside/i.test((evil as any).error) && evilLeft.length === 0 && !fs.existsSync(path.join(sitesRoot, "..", "evil.txt")), "a ZIP with a path outside its folder is refused, and the app it would have made is taken away", (evil as any).error);

  // ── a whole conversation, against this API ──
  class Script {
    requests: any[] = [];
    i = 0;
    constructor(private turns: any[]) {}
    async complete(req: any, onText: (s: string) => void) {
      this.requests.push(JSON.parse(JSON.stringify(req)));
      const t = this.turns[this.i++] ?? { content: [{ type: "text", text: "(end)" }], stopReason: "end_turn" };
      for (const b of t.content) if (b.type === "text") onText(b.text);
      return t;
    }
  }
  const use = (id: string, name: string, input: unknown) => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" });
  const llm = new Script([
    use("t1", "check_project", { file: path.basename(folder) }),
    use("t2", "propose_plan", { app: "hello", tools: ["deploy_zip"], steps: ["Upload the folder and deploy it as hello, with the TOKEN you gave"] }),
    use("t3", "deploy_zip", { file: path.basename(folder), name: "hello", variables: { TOKEN: "{{secret:TOKEN}}" } }),
    use("t4", "list_apps", {}),
    { content: [{ type: "text", text: "hello is deploying." }], stopReason: "end_turn" },
  ]);
  const ownerTok = newToken();
  await db.insert(apiTokens).values({ userId: ownerRow.id, name: "dk", scope: "deploy", tokenHash: ownerTok.hash, prefix: ownerTok.prefix });
  const changes: any[] = [];
  const conv = A.createConversation(
    { apiBase: base, token: ownerTok.raw, llm: { provider: "anthropic", apiKey: "not-used", model: A.DEFAULT_MODEL }, approve: "auto-read-only", beforeChange: async (p: any) => (changes.push(p), true) },
    { llm }
  );
  const events: any[] = [];
  const secret = "conversation-secret-9876543210";
  await conv.send(`deploy this folder as hello, TOKEN=${secret}`, [{ path: folder, name: path.basename(folder) }], (e: any) => {
    events.push(e);
    if (e.type === "plan") setTimeout(() => conv.approvePlan(e.id, true), 1);
  });
  const [hello] = await db.select().from(sites).where(eq(sites.domain, "hello.localhost"));
  const helloEnv = hello ? await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, hello.id)) : [];
  const results = events.filter((e) => e.type === "tool_result");
  pass(/Static/i.test(results[0]?.summary) && events.filter((e) => e.type === "plan").length === 1 && hello && helloEnv.map((r: any) => r.key).join() === "TOKEN", "a conversation checks the folder (a static site), asks once, uploads it and the app exists with its variable", JSON.stringify(results));
  pass(results.every((r: any) => r.ok) && results.some((r: any) => /hello\.localhost uploaded/.test(r.summary)), "every step reports back in one line", JSON.stringify(results.map((r: any) => r.summary)));
  pass(!JSON.stringify(llm.requests).includes(secret) && !JSON.stringify(events).includes(secret) && !JSON.stringify(changes).includes(secret), "the secret went to Deploy King, never to the model, the events or the approval hook");
  pass(changes.length === 1 && changes[0].actions[0].tool === "deploy_zip" && changes[0].actions[0].file?.sha256?.length === 64, "the approval hook (Deploy King Cloud later) got the exact upload: tool, file, checksum", JSON.stringify(changes[0]?.actions));
  pass(events.at(-1)?.type === "done" && events.at(-1)?.stopReason === "end_turn", "the conversation ends with done");

  server.close();
  fs.rmSync(sitesRoot, { recursive: true, force: true });
  fs.rmSync(folder, { recursive: true, force: true });
  console.log(failed ? `${failed} check(s) failed` : "every assistant check holds");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log("CRASH " + (e?.stack ?? e));
  process.exit(1);
});
