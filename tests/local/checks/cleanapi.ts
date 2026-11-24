// Cleanup through the API against a real, EMPTY database (no containers needed): who may do what, the setting, the run record.
//   run by freshdb.sh
async function main() {
  const root = process.cwd();
  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, cleanupRuns, auditLogs } = await import("@dbbkp/db");
  const { issueSession } = await import(root + "/src/services/team");
  const { getCleanupSettings, lastRuns } = await import(root + "/src/services/cleanup");
  const jwt = (await import("jsonwebtoken")).default;
  const bcrypt = (await import("bcryptjs")).default;
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 80));
  const mk = async (username: string, role: string, extra: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role, ...extra }).returning())[0];
  const as = async (u: any, apiToken?: any) => { const s = await issueSession(u); const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1", ...(apiToken ? { apiToken } : {}) }); };
  const owner = await mk("owner", "admin");
  const dev = await mk("dev", "user", { teamRole: "developer" });
  const o = await as(owner), d = await as(dev);
  pass((await getCleanupSettings()).auto === true, "automatic cleanup is on until someone turns it off");
  pass((await o.system.setAutoCleanup({ auto: false })).auto === false && (await getCleanupSettings()).auto === false, "the owner can turn it off, and it stays off");
  pass((await o.system.setAutoCleanup({ auto: true })).auto === true, "and on again");
  pass((await code(d.system.setAutoCleanup({ auto: false }))) === "FORBIDDEN" && (await code(d.system.cleanup({ kinds: ["build-cache"] }))) === "FORBIDDEN" && (await code(d.system.usage())) === "FORBIDDEN", "a developer cannot see usage, clean up or change the setting");
  const agent = await as(owner, { id: "t", scope: "full" });
  pass((await code(agent.system.cleanup({ kinds: ["old-images"] }))) === "FORBIDDEN" && (await code(agent.system.cleanupRemove({ kind: "orphan-volume", target: "v", confirm: "v" }))) === "FORBIDDEN", "an AI agent token cannot start a cleanup or remove anything");
  pass((await code(o.system.cleanupRemove({ kind: "orphan-folder", target: "old-shop", confirm: "old-sho" }))) === "BAD_REQUEST", "removing a folder needs its exact name typed");
  pass((await code(o.system.cleanup({ kinds: [] as any }))) === "BAD_REQUEST" && (await code(o.system.cleanup({ kinds: ["orphan-folder"] as any }))) === "BAD_REQUEST", "the one-button cleanup accepts safe kinds only");
  await db.insert(cleanupRuns).values({ trigger: "weekly", userId: null, freedBytes: 5 * 1024 ** 3, results: [{ kind: "build-cache", removed: 1, bytes: 5 * 1024 ** 3, errors: [] }] });
  const runs = await lastRuns(5);
  pass(runs.length === 1 && runs[0].freedBytes === 5 * 1024 ** 3 && runs[0].results[0].kind === "build-cache", "a run is recorded with what it freed (sizes above 2 GB survive)", String(runs[0]?.freedBytes));
  await new Promise((r) => setTimeout(r, 500));
  const kinds = new Set((await db.select({ action: auditLogs.action }).from(auditLogs)).map((a: any) => a.action));
  pass(kinds.has("cleanup_settings"), "changing the setting is in the audit log");
  console.log(failed ? `${failed} FAILED` : "cleanup api holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
