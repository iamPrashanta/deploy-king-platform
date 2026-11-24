// the team rules on fixed inputs (no server needed):  cd apps/api && npx tsx <this file>
async function main() {
  const { memberPermissions, cleanGrants, manageProblem } = await import(process.cwd() + "/src/services/team");
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const perms = (r: any, g?: any) => [...memberPermissions(r, g)].sort().join(",");

  pass(perms("viewer", { createApps: true, deleteApps: true, terminal: true, agentTokens: true }) === "", "a viewer can do nothing, whatever extras are set");
  pass(perms("developer") === "cron.create,site.deploy", "a developer deploys and schedules, nothing more", perms("developer"));
  pass(perms("developer", { deleteApps: true }) === "cron.create,site.delete,site.deploy", "each extra adds exactly its own permission");
  pass(perms("developer", { terminal: true }).includes("terminal.open") && perms("developer", { terminal: true }).includes("terminal.write"), "the terminal extra covers open and write");
  pass(perms("developer", { createApps: true, agentTokens: true }) === "agent.tokens,cron.create,site.create,site.deploy", "create and agent tokens are separate extras");
  pass(JSON.stringify(cleanGrants("developer", { createApps: true, deleteApps: false, evil: true } as any)) === '{"createApps":true}', "unknown or false extras are dropped");
  pass(JSON.stringify(cleanGrants("viewer", { createApps: true })) === "{}" && JSON.stringify(cleanGrants("admin", { terminal: true })) === "{}", "only developers carry extras");

  const owner = { id: "o", isAdmin: true, isOwner: true }, admin = { id: "a", isAdmin: true, isOwner: false }, dev = { id: "d", isAdmin: false, isOwner: false };
  const t = (id: string, isOwner = false, isAdmin = false) => ({ id, isOwner, isAdmin });
  pass(manageProblem(dev, t("x")) !== null, "a member cannot manage anyone");
  pass(manageProblem(owner, t("o", true, true)) !== null && manageProblem(admin, t("o", true, true)) !== null, "the owner cannot be changed by anyone, including themselves");
  pass(manageProblem(admin, t("a", false, true)) !== null, "nobody changes their own access");
  pass(manageProblem(admin, t("b", false, true)) !== null && manageProblem(owner, t("b", false, true)) === null, "only the owner manages other admins");
  pass(manageProblem(admin, t("x"), { toAdmin: true }) !== null && manageProblem(owner, t("x"), { toAdmin: true }) === null, "only the owner can make someone an admin");
  pass(manageProblem(admin, t("x")) === null, "an admin manages developers and viewers");
  console.log(failed ? `${failed} FAILED` : "all team rules hold");
  process.exit(failed ? 1 : 0);
}
main();
