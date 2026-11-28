import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { HttpDkApi, SecretStore, MASK, checkProject, prepareUpload, toolDefs, TOOLS } from "../src/index";

test("SecretStore: what the user types becomes references; resolve gives the values back", () => {
  const s = new SecretStore();
  const text = s.captureFromUserText("set JWT_SECRET to abc123xyz and DATABASE_URL=postgres://u:pw1234@db/x, token ghp_" + "b".repeat(36) + ", PORT=3000");
  assert.ok(!text.includes("abc123xyz"));
  assert.ok(!text.includes("pw1234"));
  assert.ok(!text.includes("bbbbbbbb"));
  assert.match(text, /JWT_SECRET to \{\{secret:JWT_SECRET\}\}/);
  assert.match(text, /DATABASE_URL=\{\{secret:DATABASE_URL\}\}/);
  assert.match(text, /PORT=3000/);
  assert.equal(s.resolve("{{secret:JWT_SECRET}}"), "abc123xyz");
  assert.deepEqual(s.resolve({ A: "{{secret:DATABASE_URL}}" }), { A: "postgres://u:pw1234@db/x" });
  const out = s.resolve({ SESSION_SECRET: "{{random:48}}" }) as any;
  assert.match(out.SESSION_SECRET, /^[0-9a-f]{48}$/);
  // A random value made here is hidden under the name of the variable it went to.
  assert.equal(s.hide(`value is ${out.SESSION_SECRET}`), "value is {{secret:SESSION_SECRET}}");
  assert.throws(() => s.resolve("{{secret:MISSING}}"), /no secret called MISSING/);
});

test("SecretStore.hide masks credentials it was never told about, and leaves ordinary text alone", () => {
  const s = new SecretStore();
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
  const out = s.hide(`${key}\nAuthorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ\nsk-ant-api03-${"z".repeat(30)}\nREDIS_URL=redis://:p4ss@cache:6379\nDEBUG=true\nserver listening on 3000`);
  assert.ok(!out.includes("abc\ndef"));
  assert.ok(!out.includes("eyJzdWIi"));
  assert.ok(!out.includes("zzzzzzzz"));
  assert.ok(!out.includes("p4ss"));
  assert.match(out, /DEBUG=true/);
  assert.match(out, /server listening on 3000/);
  assert.deepEqual(s.hideValue({ key: "DATABASE_URL", JWT_SECRET: "real-value-here", password: "hunter2hunter2", name: "shop" }), {
    key: "DATABASE_URL",
    JWT_SECRET: MASK,
    password: MASK,
    name: "shop",
  });
});

test("HttpDkApi calls /mcp with the token as JSON-RPC and reads the result", async () => {
  const seen: any[] = [];
  const fake = (async (url: string, init: any) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    if (body.params.name === "boom") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "There is no app called x" }], isError: true } }));
    if (body.params.name === "denied") return new Response(JSON.stringify({ error: { message: "Missing, expired or revoked token" } }), { status: 401 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ count: 0, apps: [] }) }], isError: false } }));
  }) as any;
  const api = new HttpDkApi("http://localhost:4000/", "dk_token", fake);
  assert.deepEqual(await api.callTool("list_apps", {}), { ok: true, data: { count: 0, apps: [] } });
  assert.equal(seen[0].url, "http://localhost:4000/mcp");
  assert.equal(seen[0].init.headers.Authorization, "Bearer dk_token");
  assert.deepEqual(JSON.parse(seen[0].init.body).params, { name: "list_apps", arguments: {} });
  assert.deepEqual(await api.callTool("boom", {}), { ok: false, error: "There is no app called x" });
  const denied = await api.callTool("denied", {});
  assert.equal(denied.ok, false);
  assert.match((denied as any).error, /token was refused.*dk login/);
});

test("HttpDkApi uploads a ZIP as multipart to /mcp/upload", async () => {
  let got: any;
  const fake = (async (url: string, init: any) => {
    got = { url, form: init.body as FormData };
    return new Response(JSON.stringify({ id: "s1", name: "shop.localhost", deploymentId: "d1" }));
  }) as any;
  const api = new HttpDkApi("http://localhost:4000", "dk_token", fake);
  const r = await api.uploadZip({ zip: new Uint8Array([80, 75, 3, 4]), fileName: "shop.zip", name: "shop", port: 3000, variables: { A: "1" } });
  assert.equal(r.ok, true);
  assert.equal(got.url, "http://localhost:4000/mcp/upload");
  assert.equal(got.form.get("name"), "shop");
  assert.equal(got.form.get("port"), "3000");
  assert.equal(got.form.get("variables"), JSON.stringify({ A: "1" }));
  assert.equal((got.form.get("project") as File).name, "shop.zip");
});

test("project check refuses a ZIP with an entry outside its folder; folders are zipped without node_modules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-parts-"));
  const bad = new AdmZip();
  bad.addFile("ok.txt", Buffer.from("x"));
  const badPath = path.join(dir, "bad.zip");
  bad.writeZip(badPath);
  // adm-zip normalises names on add; write a raw entry name with ../ into the file.
  const raw = fs.readFileSync(badPath);
  fs.writeFileSync(badPath, Buffer.from(raw.toString("latin1").split("ok.txt").join("../x.t"), "latin1"));
  assert.throws(() => checkProject(badPath), /unsafe path/);
  assert.throws(() => checkProject(path.join(dir, "nope.zip")), /does not exist/);

  const app = path.join(dir, "app");
  fs.mkdirSync(path.join(app, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(app, "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(app, "node_modules", "x", "big.js"), "x".repeat(1000));
  const up = prepareUpload(app);
  const names = new AdmZip(Buffer.from(up.zip)).getEntries().map((e) => e.entryName);
  assert.deepEqual(names, ["index.html"]);
  assert.match(up.sha256, /^[0-9a-f]{64}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every tool has a schema, and every change tool says what it is in a plan", () => {
  const defs = toolDefs();
  assert.equal(defs.length, TOOLS.length);
  for (const d of defs) assert.equal(d.input_schema.type, "object");
  for (const t of TOOLS.filter((t) => t.kind === "change")) {
    assert.ok(t.action, t.name);
    assert.ok(t.step({ app: "a", name: "a", file: "x", set: {}, steps: [] }, { attachments: new Map() }).length > 0, t.name);
  }
});

test("a folder's upload follows edits to files inside it; a folder holding one folder is checked like its ZIP", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-test-"));
  fs.mkdirSync(path.join(dir, "site", "css"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site", "index.html"), "<h1>one</h1>");
  fs.writeFileSync(path.join(dir, "site", "css", "a.css"), "h1{}");
  const first = prepareUpload(dir).sha256;
  assert.equal(prepareUpload(dir).sha256, first, "unchanged: the same bytes");
  // Same folder entries, so the folders' own times stay; only the file changed.
  fs.writeFileSync(path.join(dir, "site", "css", "a.css"), "h1{color:red}");
  fs.utimesSync(path.join(dir, "site", "css", "a.css"), new Date(), new Date(Date.now() + 5000));
  assert.notEqual(prepareUpload(dir).sha256, first, "an edited file inside is uploaded as it is now");
  assert.equal(checkProject(dir).framework, checkProject(path.join(dir, "site")).framework);
  assert.match(String(checkProject(dir).summary ?? checkProject(dir).framework), /static/i);
});
