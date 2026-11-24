// Team, invitations and sign-up against a real database, through the API's own router (no HTTP, no deploys).
//   cd apps/api && DATABASE_URL=... npx tsx <this file>      needs an EMPTY database with all migrations applied
import jwt from "jsonwebtoken";

async function main() {
  const root = process.cwd();
  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, sites, sessions, invitations, accessRequests, auditLogs, siteAccess } = await import("@dbbkp/db");
  const { issueSession } = await import(root + "/src/services/team");
  const { eq } = await import("drizzle-orm");
  const bcrypt = (await import("bcryptjs")).default;

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
  };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 80));
  const anon = () => appRouter.createCaller({ user: null, ip: "10.0.0.9" });
  const as = async (u: any) => {
    const s = await issueSession(u);
    const p: any = jwt.decode(s.token);
    return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1" });
  };
  const byName = async (username: string) => (await db.select().from(users).where(eq(users.username, username)))[0];
  const tokenOf = (path: string) => path.replace("/invite/", "");
  const PW = "Team-Passw0rd-12345";

  const [ownerRow] = await db.insert(users).values({ email: "owner@test.local", username: "owner", passwordHash: await bcrypt.hash(PW, 4), role: "admin" }).returning();
  const site = (domain: string, userId: string) => db.insert(sites).values({ userId, domain, type: "image", docRoot: "/var/www/sites/" + domain, source: "image", image: "x:y", status: "active" }).returning().then((r: any[]) => r[0]);
  const A = await site("a.test", ownerRow.id);
  const B = await site("b.test", ownerRow.id);
  const owner = await as(ownerRow);

  // ── invite a developer for one app
  const access = { role: "developer" as const, allApps: false, siteIds: [A.id], grants: { agentTokens: true } };
  let [inv] = await owner.team.invite({ emails: ["Dev@Test.Local"], ...access, note: "welcome" });
  pass(inv.email === "dev@test.local" && inv.path.startsWith("/invite/dki_"), "inviting returns one link per address, shown once", inv.path.slice(0, 16) + "…");
  const stored = (await db.select().from(invitations))[0];
  pass(!JSON.stringify(stored).includes(tokenOf(inv.path)), "only a hash of the link is stored");
  let seen: any = await anon().team.invitation({ token: tokenOf(inv.path) });
  pass(seen.state === "waiting" && seen.role === "developer" && seen.apps.join() === "a.test" && seen.inviter === "owner", "the invitation page shows role, apps and who invited", JSON.stringify(seen.apps));
  seen = await anon().team.invitation({ token: "dki_" + "x".repeat(40) });
  pass(seen.state === "invalid" && Object.keys(seen).length === 1, "a wrong link reveals nothing");
  pass((await code(anon().team.accept({ token: tokenOf(inv.path), username: "dev", password: "short" }))) === "BAD_REQUEST", "a short password is refused");
  const session: any = await anon().team.accept({ token: tokenOf(inv.path), username: "dev", password: PW });
  let devRow = await byName("dev");
  pass(session.token && devRow.teamRole === "developer" && devRow.role === "user" && devRow.email === "dev@test.local", "accepting creates the member and signs them in");
  pass((await code(anon().team.accept({ token: tokenOf(inv.path), username: "dev2", password: PW }))) === "BAD_REQUEST", "the link works once");

  // ── what the developer can see and do
  let dev = await as(devRow);
  let list: any[] = await dev.sites.list();
  pass(list.length === 1 && list[0].domain === "a.test", "the developer sees only the app shared with them");
  pass((await code(dev.sites.get({ id: B.id }))) === "NOT_FOUND" && (await code(dev.sites.get({ id: A.id }))) === "OK", "another app is not found for them");
  pass((await code(dev.sites.update({ id: A.id, autoDeploy: false }))) === "OK", "they can change the shared app");
  pass((await code(dev.sites.update({ id: B.id, autoDeploy: false }))) === "NOT_FOUND", "but not an app they cannot see");
  pass((await code(dev.sites.delete({ id: A.id }))) === "FORBIDDEN", "deleting is off until it is switched on for them");
  pass((await code(dev.sites.create({ domain: "new.test", source: "image", image: "x:y" }))) === "FORBIDDEN", "so is creating apps");
  pass((await code(dev.team.members())) === "FORBIDDEN" && (await code(dev.team.invite({ emails: ["z@test.local"], ...access }))) === "FORBIDDEN" && (await code(dev.system.capacity())) === "FORBIDDEN", "team and server pages are closed to them");
  pass((await code(dev.mcp.createToken({ name: "t", scope: "read", expiresInDays: 1 }))) === "OK", "they can make an agent token because that extra is on");
  const me: any = await dev.team.me();
  pass(me.role === "developer" && me.can.includes("site.deploy") && !me.can.includes("site.delete") && !me.allApps, "the panel is told what they may do", me.can.join(","));

  // ── a viewer with every app
  [inv] = await owner.team.invite({ emails: ["view@test.local"], role: "viewer", allApps: true, siteIds: [], grants: { deleteApps: true, agentTokens: true } });
  await anon().team.accept({ token: tokenOf(inv.path), username: "view", password: PW });
  const viewRow = await byName("view");
  const view = await as(viewRow);
  pass(Object.keys(viewRow.grants).length === 0, "extras are dropped for a viewer, whatever was sent");
  pass(((await view.sites.list()) as any[]).length === 2, "a viewer with all apps sees both");
  pass((await code(view.sites.update({ id: A.id, autoDeploy: true }))) === "FORBIDDEN" && (await code(view.sites.envSet({ id: A.id, key: "K", value: "v" }))) === "FORBIDDEN" && (await code(view.sites.redeploy({ id: A.id }))) === "FORBIDDEN", "a viewer changes nothing");
  pass((await code(view.mcp.createToken({ name: "t", scope: "read", expiresInDays: 1 }))) === "FORBIDDEN", "and cannot make agent tokens");

  // ── changing a member
  await owner.team.updateMember({ id: devRow.id, role: "developer", allApps: true, siteIds: [], grants: {} });
  pass(((await dev.sites.list()) as any[]).length === 2, "giving all apps applies at once, without signing in again");
  pass((await code(dev.mcp.createToken({ name: "t2", scope: "read", expiresInDays: 1 }))) === "FORBIDDEN", "switching an extra off applies at once too");
  await owner.team.updateMember({ id: devRow.id, role: "developer", allApps: false, siteIds: [B.id], grants: { deleteApps: true } });
  list = await dev.sites.list();
  pass(list.length === 1 && list[0].domain === "b.test" && (await db.select().from(siteAccess).where(eq(siteAccess.userId, devRow.id))).length === 1, "the app list is replaced, not added to");

  // ── who may manage whom
  [inv] = await owner.team.invite({ emails: ["admin2@test.local"], role: "admin", allApps: true, siteIds: [], grants: {} });
  await anon().team.accept({ token: tokenOf(inv.path), username: "admin2", password: PW });
  const admin2Row = await byName("admin2");
  const admin2 = await as(admin2Row);
  pass(admin2Row.role === "admin" && ((await admin2.sites.list()) as any[]).length === 2, "an invited admin is an admin");
  pass((await code(admin2.team.invite({ emails: ["a3@test.local"], role: "admin", allApps: true, siteIds: [], grants: {} }))) === "FORBIDDEN", "only the owner can invite admins");
  pass((await code(admin2.team.updateMember({ id: ownerRow.id, role: "viewer", allApps: false, siteIds: [], grants: {} }))) === "FORBIDDEN" && (await code(admin2.team.remove({ id: ownerRow.id, confirm: "owner" }))) === "FORBIDDEN", "nobody can change or remove the owner");
  pass((await code(admin2.team.updateMember({ id: admin2Row.id, role: "admin", allApps: true, siteIds: [], grants: {} }))) === "FORBIDDEN" && (await code(owner.team.setSuspended({ id: ownerRow.id, suspended: true }))) === "FORBIDDEN", "and nobody can change their own access");
  pass((await code(admin2.team.updateMember({ id: viewRow.id, role: "developer", allApps: false, siteIds: [A.id], grants: {} }))) === "OK" && (await code(admin2.team.updateMember({ id: viewRow.id, role: "admin", allApps: true, siteIds: [], grants: {} }))) === "FORBIDDEN", "an admin can manage members but cannot make one an admin");
  const members: any[] = await owner.team.members();
  pass(members.find((m) => m.username === "owner")?.role === "owner" && members.find((m) => m.username === "admin2")?.role === "admin" && members.find((m) => m.username === "dev")?.sharedApps === 1, "the member list names the owner and counts shared apps", members.map((m) => m.username + ":" + m.role).join(" "));

  // ── suspend
  await owner.team.setSuspended({ id: devRow.id, suspended: true });
  pass((await code(dev.sites.list())) === "UNAUTHORIZED" && (await db.select().from(sessions).where(eq(sessions.userId, devRow.id))).length === 0, "a suspended member is signed out everywhere");
  pass((await code(anon().auth.login({ username: "dev", password: PW }))) === "FORBIDDEN", "and cannot sign in");
  await owner.team.setSuspended({ id: devRow.id, suspended: false });
  pass((await code(anon().auth.login({ username: "dev", password: PW }))) === "OK", "until the suspension is lifted");

  // ── remove hands apps over instead of deleting them
  const C = await site("c.test", devRow.id);
  pass((await code(owner.team.remove({ id: devRow.id, confirm: "wrong" }))) === "BAD_REQUEST", "removing needs the username typed");
  const gone: any = await owner.team.remove({ id: devRow.id, confirm: "dev" });
  const cNow = (await db.select().from(sites).where(eq(sites.id, C.id)))[0];
  pass(gone.appsHandedOver === 1 && cNow?.userId === ownerRow.id && !(await byName("dev")), "a removed member's own app is handed to the person removing them", "c.test now belongs to the owner");

  // ── expired, renewed, cancelled, replaced
  [inv] = await owner.team.invite({ emails: ["late@test.local"], ...access });
  await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.email, "late@test.local"));
  seen = await anon().team.invitation({ token: tokenOf(inv.path) });
  pass(seen.state === "expired" && (await code(anon().team.accept({ token: tokenOf(inv.path), username: "late", password: PW }))) === "BAD_REQUEST", "an expired link says so and cannot be used");
  const waiting: any[] = await owner.team.invitations();
  const fresh: any = await owner.team.renewInvite({ id: waiting.find((i) => i.email === "late@test.local").id });
  pass((await anon().team.invitation({ token: tokenOf(fresh.path) }) as any).state === "waiting" && (await anon().team.invitation({ token: tokenOf(inv.path) }) as any).state === "invalid", "a renewed invitation has a new link and the old one is dead");
  const [again] = await owner.team.invite({ emails: ["late@test.local"], ...access });
  pass((await anon().team.invitation({ token: tokenOf(fresh.path) }) as any).state === "cancelled" && (await anon().team.invitation({ token: tokenOf(again.path) }) as any).state === "waiting", "inviting the same address again replaces the earlier link");
  await owner.team.cancelInvite({ id: (await owner.team.invitations() as any[]).find((i) => i.email === "late@test.local").id });
  pass((await anon().team.invitation({ token: tokenOf(again.path) }) as any).state === "cancelled", "a cancelled invitation stops working");
  pass((await code(owner.team.invite({ emails: ["view@test.local"], ...access }))) === "CONFLICT", "an existing member cannot be invited again");

  // ── sign-up: request access
  const r1: any = await anon().team.requestAccess({ email: "new@test.local", name: "New Person", message: "hello" });
  await anon().team.requestAccess({ email: "new@test.local", name: "New Person" });
  await anon().team.requestAccess({ email: "view@test.local", name: "Already Here" });
  const reqs: any[] = await owner.team.requests();
  pass(r1.received && reqs.length === 1 && reqs[0].email === "new@test.local", "a request is stored once, and a member's address creates none");
  pass((await code(dev.team.requests().catch((e: any) => { throw e; }))) !== "OK" && (await code(view.team.decideRequest({ id: reqs[0].id, approve: true }))) === "FORBIDDEN", "only admins see and decide requests");
  const ok: any = await owner.team.decideRequest({ id: reqs[0].id, approve: true });
  await anon().team.accept({ token: tokenOf(ok.path), username: "newbie", password: PW });
  const newRow = await byName("newbie");
  const newbie = await as(newRow);
  pass(ok.approved && newRow.teamRole === "developer" && newRow.grants.createApps === true && !newRow.allApps && ((await newbie.sites.list()) as any[]).length === 0, "an approved person can create their own apps and sees no one else's");
  pass((await code(owner.team.decideRequest({ id: reqs[0].id, approve: false }))) === "NOT_FOUND" && ((await owner.team.requests()) as any[]).length === 0, "a request is decided once");
  for (let i = 0; i < 5; i++) await anon().team.requestAccess({ email: `flood${i}@test.local`, name: "Flood" }).catch(() => {});
  pass((await code(anon().team.requestAccess({ email: "flood9@test.local", name: "Flood" }))) === "TOO_MANY_REQUESTS", "requests from one address are limited");

  await new Promise((r) => setTimeout(r, 600));
  const audit = await db.select({ action: auditLogs.action }).from(auditLogs);
  const kinds = new Set(audit.map((a: any) => a.action));
  pass(["team_invite", "team_accept", "team_member_update", "team_member_suspend", "team_member_remove", "access_request_decide"].every((k) => kinds.has(k)), "every team change is in the audit log", [...kinds].filter((k: any) => String(k).startsWith("team") || String(k).startsWith("access")).join(","));

  console.log(failed ? `${failed} FAILED` : "team flow holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
