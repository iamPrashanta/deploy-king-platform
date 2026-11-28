// 2-step sign-in, invitation emails and alerts against a real database, through the API's own router (no HTTP, no SMTP, no network).
//   cd apps/api && DATABASE_URL=... npx tsx <this file>      needs an EMPTY database with all migrations applied
// Email goes to a fake transport and webhooks to a fake fetch, so nothing leaves the machine.
import jwt from "jsonwebtoken";

process.env.MASTER_KEY ||= "0".repeat(63) + "1"; // test key only

async function main() {
  const root = process.cwd();
  const { appRouter } = await import(root + "/src/trpc/index");
  const { createContext } = await import(root + "/src/trpc/trpc");
  const { db, users, sites, sessions, sessionDevices, userTwoFactor, platformSettings, alertState, auditLogs, apiTokens } = await import("@dbbkp/db");
  const { issueSession } = await import(root + "/src/services/team");
  const twoStep = await import(root + "/src/services/twofactor");
  const hostwatch = await import(root + "/src/services/hostwatch");
  const notify = await import("@dbbkp/notify");
  const { eq } = await import("drizzle-orm");
  const bcrypt = (await import("bcryptjs")).default;

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
  };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 80));
  const anon = () => appRouter.createCaller({ user: null, ip: "10.0.0.9", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0" });
  const callerFor = (token: string) => {
    const p: any = jwt.decode(token);
    return appRouter.createCaller({ user: { sub: p.sub, sid: p.sid, username: p.username, role: p.role, mustChangePassword: false }, ip: "10.0.0.1" });
  };
  const as = async (u: any) => callerFor((await issueSession(u)).token);
  const byName = async (username: string) => (await db.select().from(users).where(eq(users.username, username)))[0];
  const sessionsOf = async (id: string) => (await db.select().from(sessions).where(eq(sessions.userId, id))).length;
  const tfRow = async (id: string) => (await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, id)))[0];
  const tokenOf = (path: string) => path.replace("/invite/", "");
  const PW = "Secure-Passw0rd-12345";
  const step = 30_000;

  const [ownerRow] = await db.insert(users).values({ email: "owner@test.local", username: "owner", passwordHash: await bcrypt.hash(PW, 4), role: "admin" }).returning();
  const owner = await as(ownerRow);
  const [A] = await db.insert(sites).values({ userId: ownerRow.id, domain: "shop-api", type: "image", docRoot: "/var/www/sites/shop-api", source: "image", image: "x:y", status: "active" }).returning();

  // ── pure: codes, windows, replays, recovery codes
  const fixed = twoStep.newSecret();
  const t0 = 1_800_000_000_000;
  pass(/^[A-Z2-7]{32}$/.test(fixed), "a secret is 160 random bits in base32", fixed.length + " characters");
  pass(twoStep.checkCode(fixed, twoStep.codeAt(fixed, t0), null, t0).ok && twoStep.checkCode(fixed, twoStep.codeAt(fixed, t0 - step), null, t0).ok && !twoStep.checkCode(fixed, twoStep.codeAt(fixed, t0 - 3 * step), null, t0).ok, "a code is accepted for one step either side, not older");
  const used = twoStep.checkCode(fixed, twoStep.codeAt(fixed, t0), null, t0);
  pass(!twoStep.checkCode(fixed, twoStep.codeAt(fixed, t0), used.step, t0).ok, "the same code is never accepted twice");
  const rc = twoStep.newRecoveryCodes();
  pass(rc.codes.length === 10 && new Set(rc.codes).size === 10 && rc.codes.every((c: string) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)) && twoStep.hashRecovery(rc.codes[0].toUpperCase().replace("-", " ")) === rc.hashes[0], "ten recovery codes, forgiving about case and dashes", rc.codes[0]);

  // ── enrol your own 2-step sign-in
  const start: any = await owner.twoFactor.start();
  pass(start.qr.startsWith("data:image/png;base64,") && start.uri.startsWith("otpauth://totp/Deploy%20King:owner?") && start.uri.includes("secret=" + start.secret), "setup shows a QR code and the key to type", start.uri.split("?")[0]);
  let row = await tfRow(ownerRow.id);
  pass(row && !row.enabledAt && !JSON.stringify(row).includes(start.secret), "the secret is stored encrypted, and is not active yet");
  pass((await anon().auth.login({ username: "owner", password: PW }) as any).token, "until it is confirmed, signing in needs only the password");
  pass((await code(owner.twoFactor.confirm({ code: "000000" }))) === "UNAUTHORIZED", "a wrong code does not turn it on");
  const conf: any = await owner.twoFactor.confirm({ code: twoStep.codeAt(start.secret) });
  row = await tfRow(ownerRow.id);
  pass(conf.recoveryCodes.length === 10 && row.enabledAt && row.recoveryHashes.length === 10 && !conf.recoveryCodes.some((c: string) => JSON.stringify(row).includes(c)), "confirming turns it on and shows recovery codes once; only hashes are kept");
  pass((await owner.twoFactor.status() as any).enabled === true && (await code(owner.twoFactor.start())) === "CONFLICT", "it cannot be started over while on");

  // ── sign in with it
  const before = await sessionsOf(ownerRow.id);
  const first: any = await anon().auth.login({ username: "owner", password: PW });
  pass(first.step === "code" && first.challenge && !first.token && (await sessionsOf(ownerRow.id)) === before, "the password alone gives no session, only a challenge for the code");
  const ctxFromChallenge = createContext({ req: { headers: { authorization: "Bearer " + first.challenge }, socket: {} } });
  pass(ctxFromChallenge.user === null && (await code(appRouter.createCaller(ctxFromChallenge).sites.list())) === "UNAUTHORIZED", "the challenge cannot be used as a session");
  pass((await code(anon().auth.setupStart({ challenge: first.challenge }))) === "UNAUTHORIZED", "a challenge for the code cannot be used to set up again");
  const inNow = twoStep.codeAt(start.secret, Date.now() + step); // the next code: the confirm used the current one
  const signed: any = await anon().auth.loginCode({ challenge: first.challenge, code: inNow });
  pass(signed.token && (await sessionsOf(ownerRow.id)) === before + 1, "the right code signs in");
  pass((await code(anon().auth.loginCode({ challenge: first.challenge, code: inNow }))) === "UNAUTHORIZED", "the same code does not work a second time");
  const dev0 = (await db.select().from(sessionDevices).where(eq(sessionDevices.userId, ownerRow.id))).find((d: any) => d.method === "2-step");
  pass(dev0?.userAgent?.includes("Chrome") && dev0?.ip === "10.0.0.9", "the device and address of the sign-in are recorded", dev0?.method);
  const rec: any = await anon().auth.loginCode({ challenge: (await anon().auth.login({ username: "owner", password: PW }) as any).challenge, code: conf.recoveryCodes[0].toUpperCase() });
  pass(rec.token && rec.recoveryLeft === 9, "a recovery code signs in instead, and is used up", `${rec.recoveryLeft} left`);
  pass((await code(anon().auth.loginCode({ challenge: (await anon().auth.login({ username: "owner", password: PW }) as any).challenge, code: conf.recoveryCodes[0] }))) === "UNAUTHORIZED", "a recovery code works once");

  // ── too many wrong codes
  await db.update(userTwoFactor).set({ failures: 0 }).where(eq(userTwoFactor.userId, ownerRow.id)); // the wrong codes above were not in a row with these
  const ch = (await anon().auth.login({ username: "owner", password: PW }) as any).challenge;
  const wrong: string[] = [];
  for (let i = 0; i < 5; i++) wrong.push(await code(anon().auth.loginCode({ challenge: ch, code: String(100000 + i) })));
  pass(wrong.slice(0, 4).every((w) => w === "UNAUTHORIZED") && wrong[4] === "TOO_MANY_REQUESTS", "the fifth wrong code in a row locks code entry", wrong.join(","));
  await db.update(userTwoFactor).set({ lastStep: null }).where(eq(userTwoFactor.userId, ownerRow.id)); // as if a minute went by
  pass((await code(anon().auth.loginCode({ challenge: ch, code: twoStep.codeAt(start.secret) }))) === "TOO_MANY_REQUESTS", "while locked, even the right code is refused");
  await db.update(userTwoFactor).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(userTwoFactor.userId, ownerRow.id));
  pass((await code(anon().auth.loginCode({ challenge: ch, code: twoStep.codeAt(start.secret) }))) === "OK", "after 15 minutes the right code works again");

  // ── a developer, then the team rule
  let [inv]: any[] = await owner.team.invite({ emails: ["dev@test.local"], role: "developer", allApps: false, siteIds: [A.id], grants: {} });
  pass(inv.emailed === false && !inv.emailError, "without SMTP the invitation is made and not emailed; the link is returned to copy");
  await anon().team.accept({ token: tokenOf(inv.path), username: "dev", password: PW });
  const devRow = await byName("dev");
  const dev = await as(devRow);
  pass((await code(dev.team.setRules({ requireTwoFactor: true }))) === "FORBIDDEN" && (await code(dev.team.resetTwoFactor({ id: ownerRow.id }))) === "FORBIDDEN", "only the owner and admins set team rules and reset 2-step sign-in");
  await owner.team.setRules({ requireTwoFactor: true });
  const rules: any = await owner.team.rules();
  pass(rules.requireTwoFactor && rules.twoFactorCount === 1 && rules.memberCount === 2, "the rule is on, and the page can say 1 of 2 use it");
  const members: any[] = await owner.team.members();
  pass(members.find((m) => m.username === "owner")?.twoFactor === true && members.find((m) => m.username === "dev")?.twoFactor === false, "the member list shows who has 2-step sign-in");
  pass(((await dev.sites.list()) as any[]).length === 1, "someone already signed in is not thrown out by the rule");
  const forced: any = await anon().auth.login({ username: "dev", password: PW });
  pass(forced.step === "setup" && !forced.token, "at the next sign-in a member without it must set it up first");
  pass((await code(anon().auth.loginCode({ challenge: forced.challenge, code: "123456" }))) === "UNAUTHORIZED", "a setup challenge is not a code challenge");
  const s2: any = await anon().auth.setupStart({ challenge: forced.challenge });
  pass(s2.qr.startsWith("data:image/png") && s2.username === "dev", "setup during sign-in shows the QR code");
  const done: any = await anon().auth.setupConfirm({ challenge: forced.challenge, code: twoStep.codeAt(s2.secret) });
  pass(done.token && done.recoveryCodes.length === 10 && (await tfRow(devRow.id)).enabledAt, "confirming it signs the member in, with recovery codes");
  pass(((await anon().auth.login({ username: "dev", password: PW })) as any).step === "code", "from then on sign-in asks for the code");
  const devNow = callerFor(done.token);
  pass((await code(devNow.twoFactor.disable({ code: twoStep.codeAt(s2.secret, Date.now() + step) }))) === "FORBIDDEN", "while the team requires it, a member cannot turn it off");

  // ── an admin resets a member's 2-step sign-in
  const sBefore = await sessionsOf(devRow.id);
  await owner.team.resetTwoFactor({ id: devRow.id });
  pass(sBefore > 0 && (await sessionsOf(devRow.id)) === 0 && !(await tfRow(devRow.id)), "resetting removes it and signs the member out everywhere");
  pass(((await anon().auth.login({ username: "dev", password: PW })) as any).step === "setup", "they set it up again at their next sign-in");
  pass((await code(owner.team.resetTwoFactor({ id: ownerRow.id }))) === "FORBIDDEN", "the owner's own cannot be reset from the team page");

  // ── accepting an invitation when the team requires it
  [inv] = await owner.team.invite({ emails: ["new@test.local"], role: "viewer", allApps: true, siteIds: [], grants: {} });
  pass(((await anon().team.invitation({ token: tokenOf(inv.path) })) as any).twoStepRequired === true, "the invitation page says the team requires 2-step sign-in");
  const acc: any = await anon().team.accept({ token: tokenOf(inv.path), username: "newbie", password: PW });
  pass(acc.step === "setup" && !acc.token && (await sessionsOf((await byName("newbie")).id)) === 0, "accepting goes to setting it up before any session exists");
  await owner.team.setRules({ requireTwoFactor: false });
  const off: any = await devNow.twoFactor.status().catch(() => null);
  pass(off === null, "(the reset session no longer works)");

  // ── member access page: devices, tokens, sign out everywhere
  const devAgain: any = await anon().auth.login({ username: "dev", password: PW });
  const devCaller = callerFor(devAgain.token);
  await db.insert(apiTokens).values({ userId: devRow.id, name: "cursor-laptop", scope: "deploy", tokenHash: "f".repeat(64), prefix: "dk_test" });
  let m: any = await owner.team.member({ id: devRow.id });
  pass(m.devices.length >= 1 && m.devices[0].userAgent?.includes("Chrome") && m.tokens.length === 1 && m.tokens[0].name === "cursor-laptop" && m.joinedAt && m.invitedBy === "you" && m.twoFactor === false, "one member's page has devices, agent tokens, joined and invited by", `${m.devices.length} device(s)`);
  pass(m.activity.some((a: any) => a.action === "team_accept"), "and their recent activity");
  const out: any = await owner.team.signOutEverywhere({ id: devRow.id });
  pass(out.sessions >= 1 && (await code(devCaller.sites.list())) === "UNAUTHORIZED", "Sign out everywhere ends every session", `${out.sessions} ended`);
  await owner.team.revokeMemberToken({ id: devRow.id, tokenId: m.tokens[0].id });
  m = await owner.team.member({ id: devRow.id });
  pass(m.tokens.length === 0, "an admin can revoke a member's agent token");

  // ── email: SMTP settings, test email, invitation emails
  const outbox: any[] = [];
  notify.setTransportForTests({ sendMail: async (msg: any) => { outbox.push(msg); return { messageId: "x" }; } });
  const devFresh = await as(devRow);
  pass((await code(devFresh.notify.email())) === "FORBIDDEN", "only admins see the email settings");
  await owner.notify.saveEmail({ host: "smtp.test.local", port: 587, security: "starttls", user: "mailer", password: "smtp-Secret-pass", from: "no-reply@test.local", panelUrl: "https://portal.test.local/", teamName: "Acme" });
  const stored = JSON.stringify((await db.select().from(platformSettings).where(eq(platformSettings.key, "email")))[0]);
  const view: any = await owner.notify.email();
  pass(!stored.includes("smtp-Secret-pass") && view.passwordSet && !JSON.stringify(view).includes("smtp-Secret-pass") && view.configured && view.panelUrl === "https://portal.test.local", "the SMTP password is stored encrypted and never sent back");
  await owner.notify.saveEmail({ host: "smtp.test.local", port: 587, security: "starttls", user: "mailer", from: "no-reply@test.local", panelUrl: "https://portal.test.local", teamName: "Acme" });
  pass(((await owner.notify.email()) as any).passwordSet, "saving without a password keeps the saved one");
  const t: any = await owner.notify.testEmail({});
  pass(t.sentTo === "owner@test.local" && outbox[0]?.subject === "Deploy King test email" && outbox[0]?.from === "Deploy King <no-reply@test.local>", "Send test email goes to you, from Deploy King");
  outbox.length = 0;
  [inv] = await owner.team.invite({ emails: ["lena@test.local"], role: "developer", allApps: false, siteIds: [A.id], grants: {}, note: "Welcome! <b>Start</b> with shop-api." });
  const mail = outbox[0];
  pass(inv.emailed === true && outbox.length === 1 && mail.to === "lena@test.local" && mail.subject === "owner invited you to Acme on Deploy King", "creating an invitation emails it", mail?.subject);
  pass(mail.text.includes("https://portal.test.local" + inv.path) && mail.html.includes("https://portal.test.local" + inv.path) && mail.text.includes("Your role: Developer") && mail.text.includes("Apps: shop-api") && mail.text.includes("only for lena@test.local"), "the email has the role, the apps and the one-time link");
  pass(mail.html.includes("&lt;b&gt;Start&lt;/b&gt;") && !mail.html.includes("<b>Start</b>") && mail.replyTo === "owner@test.local", "the note is escaped in the HTML, and replies go to the inviter");
  const listed: any[] = await owner.team.invitations();
  outbox.length = 0;
  const again: any = await owner.team.renewInvite({ id: listed.find((i) => i.email === "lena@test.local").id });
  pass(again.emailed && outbox.length === 1 && outbox[0].text.includes(again.path) && !outbox[0].text.includes(inv.path) && ((await anon().team.invitation({ token: tokenOf(inv.path) })) as any).state === "invalid", "Send again emails a new link and the old one stops working");
  outbox.length = 0;
  const copy: any = await owner.team.renewInvite({ id: listed.find((i) => i.email === "lena@test.local").id, send: false });
  pass(!copy.emailed && outbox.length === 0 && copy.path.startsWith("/invite/"), "Copy link makes a link without sending email");
  notify.setTransportForTests({ sendMail: async () => { throw new Error("535 Authentication failed"); } });
  const [bad]: any[] = await owner.team.invite({ emails: ["sam@test.local"], role: "viewer", allApps: true, siteIds: [], grants: {} });
  pass(!bad.emailed && bad.emailError?.includes("535") && bad.path.startsWith("/invite/"), "when the SMTP server refuses, the invitation still exists and says why", bad.emailError);
  pass((await code(owner.notify.testEmail({}))) === "BAD_REQUEST", "and Send test email shows the error");
  notify.setTransportForTests({ sendMail: async (msg: any) => { outbox.push(msg); return {}; } });
  const plain = notify.renderInviteEmail({ inviter: "Meera", inviterEmail: null, teamName: "", email: "x@y.z", role: "viewer", allApps: true, apps: [], url: "https://p/invite/abc", expiresAt: new Date("2026-11-27T10:00:00Z") });
  pass(plain.subject === "Meera invited you to Deploy King" && plain.text.includes("expires on 27 Nov 2026") && plain.text.includes("Apps: All apps"), "without a team name the email still reads well", plain.subject);

  // ── alerts
  const hooks: any[] = [];
  notify.setWebhookFetchForTests(async (url: string, init: any) => { hooks.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; });
  const job = { id: "11111111-1111-1111-1111-111111111111", name: "nightly-report", notifyOnFailure: true, siteId: A.id };
  pass((await notify.alertJobFailed(job, A, 5, "failed")).reason === "no channel", "with no channel switched on, nothing is sent");
  pass((await code(devFresh.notify.saveAlerts({ email: { on: true, admins: true, to: [] }, webhook: { on: false }, events: notify.DEFAULT_EVENTS }))) === "FORBIDDEN", "only admins change alerts");
  await owner.notify.saveAlerts({ email: { on: true, admins: true, to: ["oncall@test.local"] }, webhook: { on: true }, webhookUrl: "https://hooks.slack.com/services/T000/B000/secretpart", events: { ...notify.DEFAULT_EVENTS, jobFailed: { on: true, after: 3 } } });
  const av: any = await owner.notify.alerts();
  const storedA = JSON.stringify((await db.select().from(platformSettings).where(eq(platformSettings.key, "alerts")))[0]);
  pass(!storedA.includes("secretpart") && av.webhook.urlSet && av.webhook.urlHint === "https://hooks.slack.com/…" && !JSON.stringify(av).includes("secretpart"), "the webhook address is stored encrypted; the panel sees only its host");
  outbox.length = 0;
  pass((await notify.alertJobFailed(job, A, 2, "failed")).sent === false && hooks.length === 0, "two failures in a row are below the limit of 3: no alert");
  const a1 = await notify.alertJobFailed(job, A, 3, "failed");
  pass(a1.sent && a1.result?.webhook === "sent" && a1.result?.email === "sent" && hooks.length === 1 && typeof hooks[0].body.text === "string" && hooks[0].body.text.includes("nightly-report"), "the third failure in a row alerts by webhook and email", JSON.stringify(a1.result));
  pass(outbox.map((o) => o.to).sort().join() === "oncall@test.local,owner@test.local" && outbox[0].text.includes("https://portal.test.local/apps/"), "the email goes to the admins and the extra address, with a link to the panel", outbox.map((o) => o.to).join(","));
  const a2 = await notify.alertJobFailed(job, A, 4, "failed");
  const a3 = await notify.alertJobFailed(job, A, 5, "timeout");
  const st = (await db.select().from(alertState).where(eq(alertState.itemKey, job.id)))[0];
  pass(!a2.sent && a2.reason === "repeat" && !a3.sent && hooks.length === 1 && st.suppressed === 2, "more failures within the hour are counted, not sent", `${st.suppressed} held back`);
  const both = await Promise.all([notify.alertDeployFailed(A, { id: "d" }, "Build failed: npm ERR!"), notify.alertDeployFailed(A, { id: "d" }, "Build failed: npm ERR!")]);
  pass(both.filter((b) => b.sent).length === 1, "two alerts for the same item at the same moment send once");
  await db.update(alertState).set({ lastSentAt: new Date(Date.now() - 61 * 60_000) }).where(eq(alertState.itemKey, job.id));
  pass((await notify.alertJobFailed(job, A, 6, "failed")).sent, "an hour later, still failing, it alerts again");
  await owner.notify.saveAlerts({ email: { on: false, admins: true, to: [] }, webhook: { on: true }, events: { ...notify.DEFAULT_EVENTS, deployFailed: { on: false } } });
  pass((await notify.alertDeployFailed({ id: "22222222-2222-2222-2222-222222222222", domain: "other" }, { id: "d" }, "x")).reason === "event off", "an event that is switched off sends nothing");
  pass((await owner.notify.alerts() as any).webhook.urlSet, "saving without a webhook address keeps the saved one");
  pass(JSON.stringify(notify.webhookBody("https://discord.com/api/webhooks/1/abc", { kind: "deploy_failed", title: "T", text: "x" })).includes('"content":"**T**'), "Discord gets the message in content, Slack in text");
  hooks.length = 0;
  const tst: any = await owner.notify.testAlert();
  pass(tst.webhook === "sent" && hooks.length === 1 && hooks[0].body.text.includes("Test alert"), "Send test alert reports what each channel answered");
  hooks.length = 0;
  const w1 = await notify.alertWorkerCrashing(A, { name: "queue", container: "dbbkp-shop-api-worker-queue-1" });
  const w2 = await notify.alertWorkerCrashing(A, { name: "queue", container: "dbbkp-shop-api-worker-queue-1" });
  const w3 = await notify.alertWorkerCrashing(A, { name: "mailer", container: "dbbkp-shop-api-worker-mailer-1" });
  const ap = await notify.alertAppCrashing(A, { restarts: 6, outOfMemory: true, lastLine: "FATAL ERROR: heap limit" });
  pass(w1.sent && !w2.sent && w2.reason === "repeat" && w3.sent && ap.sent && hooks.length === 3 && hooks[0].body.text.includes('Worker "queue"') && hooks[2].body.text.includes("ran out of memory"), "a crashing worker alerts once an hour, each worker and the app on their own");

  // ── the server watch: an urgent finding alerts
  hooks.length = 0;
  const report = (items: any[]) => ({ version: 1 as const, generatedAt: new Date(Date.now() + items.length * 1000).toISOString(), hostname: "prod-1", asRoot: true, scanned: ["user"] as any, items });
  await hostwatch.ingest(report([{ kind: "user", key: "user:alice", label: "alice", detail: { uid: 1000, login: true }, fp: "a1" }]));
  pass(hooks.length === 0, "the first scan is the baseline: no alerts");
  await hostwatch.ingest(report([{ kind: "user", key: "user:alice", label: "alice", detail: { uid: 1000, login: true }, fp: "a1" }, { kind: "user", key: "user:toor", label: "toor", detail: { uid: 0, login: true }, fp: "t1" }]));
  pass(hooks.length === 1 && hooks[0].body.text.includes("toor") && hooks[0].body.text.includes("same as root"), "a new urgent finding on the server alerts", hooks[0]?.body?.text?.split("\n")[0]);

  // ── the GitHub App: manifest, keys kept encrypted, installations, tokens
  const gh = await import("@dbbkp/github");
  const nodeCrypto = await import("node:crypto");
  const { gitProviders, githubAppInstallations } = await import("@dbbkp/db");
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const calls: any[] = [];
  gh.setGithubFetchForTests(async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: init.headers?.Authorization ?? null });
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("/app-manifests/good-code/conversions")) return json({ id: 1048577, slug: "deploy-king-prod-1", name: "Deploy King (prod-1)", owner: { login: "acme" }, html_url: "https://github.com/apps/deploy-king-prod-1", client_id: "Iv1.x", client_secret: "cs-secret", webhook_secret: "wh-secret-123", pem });
    if (url.endsWith("/app/installations?per_page=100&page=1")) return json([{ id: 77, account: { login: "acme-labs", type: "Organization" }, repository_selection: "all" }, { id: 78, account: { login: "lena", type: "User" }, repository_selection: "selected" }]);
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) return json({ token: "ghs_installtoken" + url.match(/installations\/(\d+)/)![1], expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.includes("/installation/repositories")) return json({ repositories: [{ full_name: "acme-labs/billing", name: "billing", private: true, default_branch: "main", clone_url: "https://github.com/acme-labs/billing.git", pushed_at: "2026-11-01T00:00:00Z" }] });
    return { ok: false, status: 404, json: async () => ({}), text: async () => '{"message":"Not Found"}' };
  });
  const man: any = await owner.git.appManifest({ origin: "https://panel.test.local" });
  const manifest = JSON.parse(man.manifest);
  pass(man.postUrl.startsWith("https://github.com/settings/apps/new?state=") && manifest.default_permissions.contents === "read" && !manifest.default_permissions.administration && manifest.default_events.join() === "push,pull_request" && manifest.redirect_url === "https://panel.test.local/settings/github", "the app is asked for read access to code and the push and pull request events only");
  const state = decodeURIComponent(man.postUrl.split("state=")[1]);
  pass((await code(devFresh.git.appManifest({ origin: "https://panel.test.local" }))) === "FORBIDDEN", "only admins create the GitHub App");
  const admin2 = await as((await db.insert(users).values({ email: "a2@test.local", username: "admin2", passwordHash: "x", role: "admin" }).returning())[0]);
  pass((await code(admin2.git.appComplete({ code: "good-code", state }))) === "BAD_REQUEST", "the code from GitHub only works for the admin who started");
  const made: any = await owner.git.appComplete({ code: "good-code", state });
  const storedApp = JSON.stringify((await db.select().from(platformSettings).where(eq(platformSettings.key, "github_app")))[0]);
  pass(made.installUrl === "https://github.com/apps/deploy-king-prod-1/installations/new" && !storedApp.includes("BEGIN RSA") && !storedApp.includes("wh-secret-123") && !storedApp.includes("cs-secret"), "its private key, webhook secret and client secret are stored encrypted");
  const jwtParts = gh.appJwt((await gh.getApp())!).split(".");
  pass(nodeCrypto.createVerify("RSA-SHA256").update(jwtParts[0] + "." + jwtParts[1]).verify(publicKey, Buffer.from(jwtParts[2], "base64url")) && JSON.parse(Buffer.from(jwtParts[1], "base64url").toString()).iss === "1048577", "the app signs its requests with its own key");
  const synced: any = await owner.git.appSync();
  const appView: any = await owner.git.app();
  pass(synced.installations === 2 && appView.installations.length === 2 && appView.installations.find((i: any) => i.account === "acme-labs")?.repositorySelection === "all", "installations are read from GitHub", appView.installations.map((i: any) => i.account).join(","));
  const provs: any[] = await owner.git.providers();
  const acme = provs.find((p) => p.login === "acme-labs");
  pass(acme?.type === "github_app", "each installation is a connection apps can use");
  const repos: any[] = await owner.git.repos({ providerId: acme.id });
  pass(repos.length === 1 && repos[0].fullName === "acme-labs/billing" && calls.some((c) => c.url.endsWith("/installation/repositories?per_page=100&page=1") && c.auth === "Bearer ghs_installtoken77"), "repositories are listed with a short-lived installation token");
  pass((await gh.tokenForProvider((await db.select().from(gitProviders).where(eq(gitProviders.id, acme.id)))[0])) === "ghs_installtoken77", "the worker gets the same kind of token to clone");
  pass((await gh.appWebhookSecret()) === "wh-secret-123", "the app's webhook secret is used to check push events");
  pass((await code(owner.git.disconnect({ id: acme.id }))) === "BAD_REQUEST", "an installation is removed on GitHub, not with Disconnect");
  gh.setGithubFetchForTests(async (url: string) => url.endsWith("/app/installations?per_page=100&page=1") ? { ok: true, status: 200, json: async () => [{ id: 77, account: { login: "acme-labs", type: "Organization" }, repository_selection: "selected" }], text: async () => "" } : { ok: false, status: 500, json: async () => ({}), text: async () => "" });
  await owner.git.appSync();
  pass((await db.select().from(githubAppInstallations)).length === 1 && ((await owner.git.app()) as any).installations[0].repositorySelection === "selected", "an installation removed on GitHub goes away here on Refresh");
  pass((await code(owner.git.appRemove({ confirm: "remove" as const }))) === "OK" && !(await gh.getApp()) && (await db.select().from(githubAppInstallations)).length === 0, "Remove forgets the app and its installations");
  gh.setGithubFetchForTests(null);

  // ── wrong passwords and codes from one address are limited, across accounts
  const rl = await import(root + "/src/services/ratelimit");
  rl.resetLimitsForTests();
  const from = (ip: string) => appRouter.createCaller({ user: null, ip, userAgent: "curl/8" });
  const badTries: string[] = [];
  for (let i = 0; i < 21; i++) badTries.push(await code(from("203.0.113.7").auth.login({ username: i % 2 ? "owner" : "nobody", password: "wrong-" + i })));
  pass(badTries.slice(0, 20).every((c) => c === "UNAUTHORIZED") && badTries[20] === "TOO_MANY_REQUESTS", "after 20 wrong passwords from one address, it must wait", badTries[20]);
  pass((await code(from("203.0.113.7").auth.login({ username: "owner", password: PW }))) === "TOO_MANY_REQUESTS", "even the right password waits");
  pass((await code(from("198.51.100.4").auth.login({ username: "owner", password: PW }))) === "OK", "another address is not affected");
  rl.resetLimitsForTests();
  const t1 = Date.now();
  for (let i = 0; i < 25; i++) rl.noteFailure("code", "203.0.113.8", t1);
  pass((() => { try { rl.checkLimit("code", "203.0.113.8", t1 + 14 * 60_000); return false; } catch { return true; } })() && (() => { try { rl.checkLimit("code", "203.0.113.8", t1 + 16 * 60_000); return true; } catch { return false; } })(), "wrong codes from one address wait 15 minutes");
  rl.resetLimitsForTests();

  await new Promise((r) => setTimeout(r, 600));
  const kinds = new Set((await db.select({ action: auditLogs.action }).from(auditLogs)).map((a: any) => a.action));
  const want = ["two_factor_enable", "two_factor_recovery_used", "two_factor_reset", "team_rules", "team_sign_out_everywhere", "team_token_revoke", "email_settings", "email_test", "alert_settings", "alert_test", "github_app_create", "github_app_install", "github_app_remove"];
  pass(want.every((k) => kinds.has(k)), "every change is in the audit log", want.filter((k) => !kinds.has(k)).join(",") || "all there");

  notify.setTransportForTests(null);
  notify.setWebhookFetchForTests(null);
  console.log(failed ? `${failed} FAILED` : "security flow holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
