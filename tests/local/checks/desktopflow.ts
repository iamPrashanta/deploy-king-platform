// Deploy King Desktop's key in the API (DESKTOP_MODE): the key check on fixed inputs, then the two
// routes over HTTP against a real, EMPTY database: no key, a wrong key, register closed, the local
// admin's session, the assistant token and its rotation, the admin made at the first start (no forced
// password change on a desktop machine), too many wrong keys, and desktop mode off.
//   run by freshdb.sh (cwd apps/api)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

async function main() {
  const root = process.cwd();
  // Packages are found from apps/api, wherever this file sits (/t in the container).
  const from = (m: string) => createRequire(path.join(root, "package.json")).resolve(m);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-desktop-"));
  const keyFile = path.join(dir, "desktop.key");
  const KEY = "k".repeat(10) + "Zx9_-" + "q".repeat(28); // 43 characters, like 32 random bytes in base64url
  fs.writeFileSync(keyFile, KEY + "\n", { mode: 0o600 });
  process.env.DESKTOP_KEY_FILE = keyFile;

  const { desktopKeyMatches, readDesktopKey, desktopModeOn } = await import(root + "/src/services/desktopKey");
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
  };

  // ── On fixed inputs ──
  pass(desktopKeyMatches(`Desktop ${KEY}`, KEY), "the right key in the Desktop header is accepted");
  pass(!desktopKeyMatches(`Bearer ${KEY}`, KEY) && !desktopKeyMatches(KEY, KEY), "only the Desktop scheme counts");
  pass(!desktopKeyMatches(`Desktop ${KEY}x`, KEY) && !desktopKeyMatches(`Desktop ${KEY.slice(0, -1)}`, KEY), "a key one character off is refused");
  pass(!desktopKeyMatches("Desktop ", KEY) && !desktopKeyMatches(undefined, KEY) && !desktopKeyMatches(["Desktop " + KEY], KEY), "an empty, missing or repeated header is refused");
  pass(!desktopKeyMatches(`Desktop ${KEY}`, null), "with no key file, nothing is accepted");
  pass(readDesktopKey(keyFile) === KEY, "the key file is read and trimmed");
  pass(readDesktopKey(path.join(dir, "missing")) === null, "a missing key file gives no key");
  fs.writeFileSync(path.join(dir, "short"), "abc");
  pass(readDesktopKey(path.join(dir, "short")) === null, "a short key file gives no key");
  pass(!desktopModeOn({}) && !desktopModeOn({ DESKTOP_MODE: "1" }) && desktopModeOn({ DESKTOP_MODE: "true" }), "desktop mode only with DESKTOP_MODE=true");

  // ── Through HTTP, desktop mode off ──
  const express = (await import(from("express"))).default;
  const { mountDesktop } = await import(root + "/src/routes/desktop");
  const serve = async (app: any) => {
    const s = app.listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };
  delete process.env.DESKTOP_MODE;
  const off = express();
  mountDesktop(off);
  const o = await serve(off);
  pass((await fetch(o.base + "/api/desktop/session", { method: "POST", headers: { Authorization: `Desktop ${KEY}` } })).status === 404, "without desktop mode the routes do not exist");
  o.s.close();

  // ── Through HTTP, desktop mode on ──
  process.env.DESKTOP_MODE = "true";
  const authRouter = (await import(root + "/src/routes/auth")).default;
  const { verifyToken } = await import(root + "/src/middleware/requireAuth");
  const { verifyApiToken } = await import(root + "/src/services/apiTokens");
  const { db, users } = await import(from("@dbbkp/db"));
  const app = express();
  app.use(express.json());
  mountDesktop(app);
  app.use("/api/auth", authRouter);
  const { s, base } = await serve(app);
  const post = (p: string, auth?: string, body?: unknown) =>
    fetch(base + p, { method: "POST", headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

  pass((await post("/api/desktop/session")).status === 401, "no key: refused");
  pass((await post("/api/desktop/session", `Desktop ${"x".repeat(43)}`)).status === 401, "a wrong key: refused");
  pass((await post("/api/desktop/session", `Bearer ${KEY}`)).status === 401, "the key as a Bearer token: refused");
  const reg = await post("/api/auth/register", undefined, { username: "intruder", email: "i@x.test", password: "x".repeat(14) });
  pass(reg.status === 403 && (await db.select().from(users)).length === 0, "registering the first account is closed on a desktop machine", String(reg.status));

  const r1 = await post("/api/desktop/session", `Desktop ${KEY}`);
  const b1 = (await r1.json()) as any;
  const who = await verifyToken(b1.token);
  pass(r1.ok && who?.role === "admin" && who.username === "local", "the right key: a working session for the local admin", JSON.stringify(who));
  const all = await db.select().from(users);
  pass(all.length === 1 && all[0]!.teamRole === "admin" && all[0]!.allApps === true, "the local admin was made once, as a full admin");
  const b2 = (await (await post("/api/desktop/session", `Desktop ${KEY}`)).json()) as any;
  pass(b2.token !== b1.token && (await verifyToken(b2.token))?.sub === who?.sub && (await db.select().from(users)).length === 1, "signing in again gives a new session for the same admin");

  const t1 = (await (await post("/api/desktop/agent-token", `Desktop ${KEY}`)).json()) as any;
  const a1 = await verifyApiToken(t1.token);
  pass(typeof t1.token === "string" && t1.token.startsWith("dk_") && a1?.scope === "deploy" && a1.user.sub === who?.sub, "the assistant gets a dk_ token with deploy access, as the local admin", a1?.scope);
  const t2 = (await (await post("/api/desktop/agent-token", `Desktop ${KEY}`)).json()) as any;
  pass((await verifyApiToken(t1.token)) === null && (await verifyApiToken(t2.token))?.scope === "deploy", "a new assistant token stops the old one");
  pass((await post("/api/desktop/agent-token")).status === 401, "the assistant token needs the key too");

  // ── The admin the API makes at its first start ──
  // It has a first password and must change it at the first sign-in. On a desktop machine the key is
  // the credential: that admin becomes the local admin, without a forced change, and its first password stops working.
  const queues = await import(root + "/src/queues");
  for (const q of Object.values(queues) as any[]) q?.on?.("error", () => {}); // no Redis here
  const { appRouter } = await import(root + "/src/trpc");
  const bcrypt = (await import(from("bcryptjs"))).default;
  const { ensureFirstAdmin } = await import(from("@dbbkp/db"));
  const callerFor = (user: any, apiToken: any = null) => appRouter.createCaller({ user: { ...user, mustChangePassword: false }, ip: null, apiToken });
  const refusedFor = async (fn: () => Promise<unknown>) => fn().then(() => "", (e: any) => String(e?.message ?? e));
  await db.delete(users); // sessions and tokens go with it
  const FIRST = "First-Start-Passw0rd-1";
  process.env.INITIAL_ADMIN_USERNAME = "admin";
  process.env.INITIAL_ADMIN_PASSWORD = FIRST;
  await ensureFirstAdmin();
  const [first] = await db.select().from(users);
  pass(first?.username === "admin" && first.mustChangePassword === true && (await bcrypt.compare(FIRST, first.passwordHash)), "the first start makes an admin that must change its first password");
  const login1 = await post("/api/auth/login", undefined, { username: "admin", password: FIRST });
  const stuck = (await verifyToken(((await login1.json()) as any).token))!;
  pass(login1.ok && (await refusedFor(() => callerFor(stuck).sites.list())) === "PASSWORD_ROTATION_REQUIRED", "signed in with that password, it can do nothing before the change (as on a server)");

  const r3 = await post("/api/desktop/session", `Desktop ${KEY}`);
  const b3 = (await r3.json()) as any;
  const who3 = await verifyToken(b3.token);
  const [fixed] = await db.select().from(users);
  pass(r3.ok && who3?.sub === first.id && (await db.select().from(users)).length === 1, "with the key, that admin is the local admin (no second account is made)", JSON.stringify(who3));
  pass(fixed.mustChangePassword === false && b3.user?.mustChangePassword === false, "it is no longer asked to change its password", JSON.stringify(b3.user));
  pass((await refusedFor(() => callerFor(who3).sites.list())) === "" && (await refusedFor(() => callerFor(who3).team.me())) === "", "so the app's session works in the panel's API");
  pass(!(await bcrypt.compare(FIRST, fixed.passwordHash)) && (await post("/api/auth/login", undefined, { username: "admin", password: FIRST })).status === 401, "and its first password no longer signs in");
  const t3 = (await (await post("/api/desktop/agent-token", `Desktop ${KEY}`)).json()) as any;
  const a3 = await verifyApiToken(t3.token);
  const asAgent = a3 ? callerFor({ sub: a3.user.sub, sid: `token:${a3.tokenId}`, username: a3.user.username, role: a3.user.role }, { id: a3.tokenId, scope: a3.scope }) : null;
  pass(!!asAgent && (await refusedFor(() => asAgent.sites.list())) === "", "the assistant's token works too (no \"must change their password\")");

  // The same when the assistant's token is the first thing the app asks for.
  await db.delete(users);
  await ensureFirstAdmin();
  const t4 = (await (await post("/api/desktop/agent-token", `Desktop ${KEY}`)).json()) as any;
  const a4 = await verifyApiToken(t4.token);
  const [fixed4] = await db.select().from(users);
  const asAgent4 = a4 ? callerFor({ sub: a4.user.sub, sid: `token:${a4.tokenId}`, username: a4.user.username, role: a4.user.role }, { id: a4.tokenId, scope: a4.scope }) : null;
  pass(fixed4.mustChangePassword === false && !(await bcrypt.compare(FIRST, fixed4.passwordHash)) && !!asAgent4 && (await refusedFor(() => asAgent4.sites.list())) === "", "asking for the assistant's token first lifts the forced change as well");

  // An admin who chose a password keeps it: only a first password that was never changed is replaced.
  const CHOSEN = "Chosen-By-The-Admin-12345";
  const { eq } = await import(from("drizzle-orm"));
  await db.update(users).set({ passwordHash: await bcrypt.hash(CHOSEN, 4) }).where(eq(users.id, fixed4.id));
  await post("/api/desktop/session", `Desktop ${KEY}`);
  const [kept] = await db.select().from(users);
  pass(await bcrypt.compare(CHOSEN, kept.passwordHash), "a password the admin chose is left alone");
  delete process.env.INITIAL_ADMIN_PASSWORD;

  // A new key in the file works at once (rotation needs no restart), and the old one stops.
  const KEY2 = "r".repeat(43);
  fs.writeFileSync(keyFile, KEY2);
  pass((await post("/api/desktop/session", `Desktop ${KEY}`)).status === 401 && (await post("/api/desktop/session", `Desktop ${KEY2}`)).ok, "after the key is rotated, only the new key works");
  fs.rmSync(keyFile);
  pass((await post("/api/desktop/session", `Desktop ${KEY2}`)).status === 401, "with the key file gone, nothing is accepted");

  let last = 0;
  for (let i = 0; i < 12; i++) last = (await post("/api/desktop/session", `Desktop ${"g".repeat(43)}`)).status;
  fs.writeFileSync(keyFile, KEY2);
  pass(last === 429 && (await post("/api/desktop/session", `Desktop ${KEY2}`)).ok, "many wrong keys are answered with 429, and the right key still works", String(last));

  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : "desktop key holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
