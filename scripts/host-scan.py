#!/usr/bin/env python3
"""Deploy King host scan.

Lists what is on this server that someone could use to get in or to stay in: users and who has admin
rights, SSH keys and settings, scheduled jobs, services and startup files, listening ports, containers.
It also lists running programs and outgoing connections, but only those with a sign of trouble (see
processes() and outbound()): every program on a server would be noise. The panel compares each report
with the one before and shows the admin what is new or changed.

It only reads. It changes nothing on the server and copies no secrets: no password hashes, no private
keys, no file contents (a checksum instead), and values that look like passwords in command lines are
blanked. Needs Python 3.6+ and nothing else. Run as root so every user's files can be read.

    host-scan.py --out /opt/dbbkp/scan/inventory.json
    host-scan.py --out -                 print the report
    host-scan.py --root DIR --ss-file F --ss-conn-file F --containers-file F --state F
                                         scan a copy of a server (used by the checks)
"""
import argparse, base64, datetime, glob, hashlib, json, os, re, socket, subprocess, sys

ROOT = ""
ITEMS = []
# The kinds that were really read this time. A kind that is missing here was not scanned (a tool was
# missing or failed), so the panel must not treat its items as removed.
SCANNED = set()


def at(path):
    return ROOT + path if ROOT else path


def read(path, limit=512 * 1024):
    try:
        with open(at(path), "r", errors="replace") as f:
            return f.read(limit)
    except (OSError, IOError):
        return None


def digest(text):
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:32]


def listdir(path):
    try:
        return sorted(os.listdir(at(path)))
    except OSError:
        return []


SECRET = re.compile(r"(?i)((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|key)\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)")
URL_AUTH = re.compile(r"(://[^/\s:@]+:)[^@\s/]+@")
MYSQL_P = re.compile(r"(\s-p)(?=\S)(?!ort)\S+")


def redact(text):
    """Blank anything in a command line that looks like a password. The checksum is taken before this."""
    text = SECRET.sub(lambda m: m.group(1) + "***", text)
    text = URL_AUTH.sub(lambda m: m.group(1) + "***@", text)
    if re.search(r"\b(mysql|mysqldump|mariadb|mariadb-dump|mysqladmin)\b", text):
        text = MYSQL_P.sub(lambda m: m.group(1) + "***", text)
    return text[:600]


def add(kind, key, label, detail, parts):
    """parts: the values that count as "the same thing, unchanged". A different checksum is a change."""
    ITEMS.append({"kind": kind, "key": key[:290], "label": label[:200], "detail": detail, "fp": digest(json.dumps(parts, sort_keys=True))})


# ── users and admin rights ──────────────────────────────────────────────────

NO_LOGIN = {"nologin", "false", "sync", "shutdown", "halt", ""}
ADMIN_GROUPS = ("sudo", "wheel", "admin", "root", "docker", "lxd")


def users():
    if read("/etc/passwd") is not None:
        SCANNED.update(("user", "admin", "ssh_key"))
    shadow = {}
    for line in (read("/etc/shadow") or "").splitlines():
        f = line.split(":")
        if len(f) >= 3:
            shadow[f[0]] = f
    found = []
    for line in (read("/etc/passwd") or "").splitlines():
        f = line.split(":")
        if len(f) < 7 or not f[0] or line.startswith("#"):
            continue
        name, uid, gid, home, shell = f[0], f[2], f[3], f[5], f[6].strip()
        can_login = os.path.basename(shell) not in NO_LOGIN
        sh = shadow.get(name)
        pw = sh[1] if sh else None
        has_password = bool(pw) and not pw.startswith(("!", "*"))
        empty_password = sh is not None and pw == ""
        changed = None
        if sh and sh[2].isdigit() and int(sh[2]) > 0:
            changed = (datetime.date(1970, 1, 1) + datetime.timedelta(days=int(sh[2]))).isoformat()
        found.append({"name": name, "uid": uid, "gid": gid, "home": home, "shell": shell, "login": can_login})
        add("user", "user:" + name, name,
            {"uid": int(uid) if uid.isdigit() else uid, "home": home, "shell": shell, "login": can_login,
             "hasPassword": has_password, "emptyPassword": empty_password, "passwordChanged": changed},
            [uid, home, shell, has_password, empty_password, changed])
    return found


def admins(found):
    by_gid = {}
    for u in found:
        by_gid.setdefault(u["gid"], []).append(u["name"])
        if u["uid"] == "0" and u["name"] != "root":
            add("admin", "admin:%s:uid 0" % u["name"], u["name"], {"user": u["name"], "via": "user id 0, the same as root"}, ["uid0"])
    for line in (read("/etc/group") or "").splitlines():
        f = line.split(":")
        if len(f) < 4 or f[0] not in ADMIN_GROUPS:
            continue
        members = set(m for m in f[3].strip().split(",") if m) | set(by_gid.get(f[2], []))
        for m in sorted(members - {"root"}):
            add("admin", "admin:%s:group %s" % (m, f[0]), m, {"user": m, "via": "member of the %s group" % f[0]}, [f[0]])
    for path in ["/etc/sudoers"] + ["/etc/sudoers.d/" + n for n in listdir("/etc/sudoers.d")]:
        for raw in (read(path) or "").splitlines():
            line = " ".join(raw.split())
            if not line or (line.startswith("#") and not line.startswith(("#include", "#includedir"))) or line.startswith(("Defaults", "@include", "#include")):
                continue
            add("admin", "sudo:%s:%s" % (path, digest(line)[:12]), line.split(" ")[0], {"file": path, "rule": line[:400], "via": "a sudo rule"}, [line])


# ── SSH ─────────────────────────────────────────────────────────────────────

KEY_TYPE = re.compile(r"^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+@openssh\.com)$")


def ssh_keys(found):
    for u in found:
        if not u["home"] or u["home"] == "/":
            continue
        for name in ("authorized_keys", "authorized_keys2"):
            path = u["home"].rstrip("/") + "/.ssh/" + name
            for raw in (read(path) or "").splitlines():
                tok = raw.strip().split()
                if not tok or tok[0].startswith("#"):
                    continue
                i = next((n for n, t in enumerate(tok) if KEY_TYPE.match(t)), None)
                if i is None or i + 1 >= len(tok):
                    continue
                try:
                    fp = "SHA256:" + base64.b64encode(hashlib.sha256(base64.b64decode(tok[i + 1])).digest()).decode().rstrip("=")
                except Exception:
                    fp = "unreadable:" + digest(tok[i + 1])[:16]
                comment = " ".join(tok[i + 2:])[:120]
                options = " ".join(tok[:i])
                add("ssh_key", "key:%s:%s" % (u["name"], fp), "%s (%s)" % (comment or tok[i], u["name"]),
                    {"user": u["name"], "type": tok[i], "fingerprint": fp, "comment": comment, "file": path, "restricted": bool(options)},
                    [fp, bool(options)])


SSHD_DEFAULTS = [("PermitRootLogin", "prohibit-password"), ("PasswordAuthentication", "yes"), ("PubkeyAuthentication", "yes"),
                 ("PermitEmptyPasswords", "no"), ("Port", "22"), ("AuthorizedKeysFile", ".ssh/authorized_keys .ssh/authorized_keys2")]


def sshd_lines(path, depth=0):
    out = []
    for raw in (read(path) or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        tok = line.split(None, 1)
        if tok[0].lower() == "include" and len(tok) > 1 and depth < 3:
            for pattern in tok[1].split():
                pattern = pattern if pattern.startswith("/") else "/etc/ssh/" + pattern
                for match in sorted(glob.glob(at(pattern))):
                    out += sshd_lines(match[len(ROOT):] if ROOT else match, depth + 1)
            continue
        if tok[0].lower() == "match":
            break  # settings after "Match" apply to some sign-ins only
        out.append(tok)
    return out


def sshd():
    if read("/etc/ssh/sshd_config") is None:
        return
    SCANNED.add("sshd")
    seen = {}
    for tok in sshd_lines("/etc/ssh/sshd_config"):
        name = tok[0].lower()
        value = tok[1].strip() if len(tok) > 1 else ""
        if name == "port":
            seen[name] = (seen[name] + " " + value) if name in seen else value
        elif name not in seen:  # the first value wins, as in sshd itself
            seen[name] = value
    for name, default in SSHD_DEFAULTS:
        value = seen.get(name.lower(), default)
        add("sshd", "sshd:" + name, name, {"setting": name, "value": value, "isDefault": name.lower() not in seen}, [value])


# ── scheduled jobs ──────────────────────────────────────────────────────────

ENV_LINE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*=")


def cron_file(path, user):
    for raw in (read(path) or "").splitlines():
        line = " ".join(raw.split())
        if not line or line.startswith("#") or ENV_LINE.match(line):
            continue
        tok = line.split(" ")
        n = 1 if tok[0].startswith("@") else 5
        if len(tok) <= n:
            continue
        schedule, rest = " ".join(tok[:n]), tok[n:]
        run_as = user
        if user is None:  # system files name the user before the command
            if len(rest) < 2:
                continue
            run_as, rest = rest[0], rest[1:]
        command = redact(" ".join(rest))
        add("cron", "cron:%s:%s" % (path, digest(line)[:12]), command[:80],
            {"file": path, "user": run_as, "schedule": schedule, "command": command}, [line])


def cron():
    SCANNED.add("cron")
    cron_file("/etc/crontab", None)
    for n in listdir("/etc/cron.d"):
        if not n.startswith("."):
            cron_file("/etc/cron.d/" + n, None)
    for base in ("/var/spool/cron/crontabs", "/var/spool/cron"):
        for n in listdir(base):
            if os.path.isfile(at(base + "/" + n)):
                cron_file(base + "/" + n, n)
    for every in ("hourly", "daily", "weekly", "monthly"):
        for n in listdir("/etc/cron." + every):
            path = "/etc/cron.%s/%s" % (every, n)
            body = read(path)
            if n.startswith(".") or body is None:
                continue
            add("cron", "cronfile:" + path, n, {"file": path, "user": "root", "schedule": every, "command": path, "script": True}, [digest(body)])


# ── services, timers and startup files ──────────────────────────────────────

LIB_DIRS = ("/usr/lib/systemd/system", "/lib/systemd/system")


def unit_value(body, name):
    m = re.search(r"(?m)^\s*%s\s*=\s*(.+)$" % re.escape(name), body)
    return m.group(1).strip() if m else None


def units(found):
    SCANNED.add("unit")
    enabled = set()
    for d in glob.glob(at("/etc/systemd/system/*.wants")) + glob.glob(at("/etc/systemd/system/*.requires")):
        try:
            enabled.update(os.listdir(d))
        except OSError:
            pass
    seen = set()
    places = [("/etc/systemd/system", "admin", ""), ("/etc/systemd/user", "admin", "user/")]
    places += [(d, "package", "") for d in LIB_DIRS]
    places += [(u["home"].rstrip("/") + "/.config/systemd/user", "home", "~%s/" % u["name"]) for u in found if u["login"] and u["home"] not in ("", "/")]
    for d, origin, prefix in places:
        for n in listdir(d):
            if not n.endswith((".service", ".timer")) or prefix + n in seen:
                continue
            full = at(d + "/" + n)
            if os.path.islink(full):
                target = os.readlink(full)
                if target == "/dev/null" or target.startswith(LIB_DIRS) or not target.startswith("/"):
                    continue  # masked, or another name for a unit that is listed on its own
            body = read(d + "/" + n)
            if body is None:
                continue
            seen.add(prefix + n)
            run = unit_value(body, "ExecStart")
            when = unit_value(body, "OnCalendar") or unit_value(body, "OnUnitActiveSec") or unit_value(body, "OnBootSec")
            detail = {"file": d + "/" + n, "origin": origin, "enabled": n in enabled, "runs": redact(run) if run else None,
                      "user": unit_value(body, "User"), "timer": n.endswith(".timer"), "when": when}
            add("unit", "unit:" + prefix + n, n, detail, [digest(body), n in enabled])


def startup(found):
    SCANNED.add("startup")
    files = ["/etc/rc.local", "/etc/ld.so.preload", "/etc/profile", "/etc/bash.bashrc", "/etc/environment"]
    files += ["/etc/profile.d/" + n for n in listdir("/etc/profile.d")]
    for u in found:
        if (u["login"] or u["name"] == "root") and u["home"] not in ("", "/"):
            files += [u["home"].rstrip("/") + "/" + n for n in (".bashrc", ".profile", ".bash_profile", ".bash_login", ".zshrc")]
    for path in files:
        body = read(path)
        if body is None:
            continue
        detail = {"file": path, "size": len(body)}
        if path == "/etc/ld.so.preload":
            detail["loads"] = [l.strip() for l in body.splitlines() if l.strip() and not l.strip().startswith("#")][:20]
        add("startup", "startup:" + path, path, detail, [digest(body)])


# ── listening ports ─────────────────────────────────────────────────────────

def ports(ss_file):
    if ss_file:
        out = open(ss_file).read()
    else:
        try:
            out = subprocess.run(["ss", "-H", "-lntup"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20).stdout.decode("utf-8", "replace")
        except Exception:
            return
    SCANNED.add("port")
    grouped = {}
    for line in out.splitlines():
        f = line.split()
        if len(f) < 5 or f[0] not in ("tcp", "udp"):
            continue
        addr, _, port = f[4].rpartition(":")
        if not port.isdigit():
            continue
        addr = addr.strip("[]").split("%")[0]
        m = re.search(r'users:\(\("([^"]+)"', line)
        g = grouped.setdefault((f[0], int(port)), {"addresses": set(), "program": None})
        g["addresses"].add(addr)
        g["program"] = g["program"] or (m.group(1) if m else None)
    for (proto, port), g in sorted(grouped.items()):
        public = any(not (a.startswith("127.") or a in ("::1", "localhost") or a.startswith("::ffff:127.")) for a in g["addresses"])
        add("port", "port:%s:%d" % (proto, port), "%s %d" % (proto, port),
            {"protocol": proto, "port": port, "program": g["program"], "public": public, "addresses": sorted(g["addresses"])},
            [g["program"], public])


# ── running programs ────────────────────────────────────────────────────────
# Only programs with a sign of trouble are listed; the panel's baseline then tells a known one from a new one.

TEMP_DIRS = ("/tmp/", "/var/tmp/", "/dev/shm/", "/run/shm/")
SYSTEM_DIRS = ("/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/opt/", "/snap/")
# Hidden folders in a home that hold real tools, so a program running from them is not a sign.
TOOL_DIRS = (".nvm", ".vscode-server", ".cursor-server", ".windsurf-server", ".cargo", ".rustup", ".bun", ".deno", ".pyenv", ".rbenv",
             ".sdkman", ".local", ".npm", ".yarn", ".volta", ".asdf", ".fnm", ".pm2", ".dotnet", ".gradle", ".m2", ".config")
# Miner names are matched against the program's own name only: a command line that merely mentions one
# (someone running "grep xmrig") is not a miner. Command lines are matched for flags only miners use.
MINER_NAME = re.compile(r"(?i)^(xmrig|xmr-stak|minerd|cpuminer|cgminer|bfgminer|ethminer|nbminer|phoenixminer|t-rex|lolminer|kdevtmpfsi|kinsing|srbminer|teamredminer)")
MINER_ARGS = re.compile(r"(?i)stratum\+(tcp|ssl|tls)://|--donate-level|--coin[ =](monero|xmr)|\s(-a|--algo)[ =](rx/0|rx/|cn/|cryptonight|randomx|kawpow)\b")
CPU_BUSY_PCT = 80
# Tools that only read or search text. Their command lines name miners when someone is looking for one.
LOOKING_TOOLS = {"grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "locate", "less", "more", "cat", "head", "tail", "vi", "vim", "nvim", "nano",
                 "sed", "awk", "gawk", "strings", "journalctl", "man", "zgrep", "xzgrep"}


def proc_stat(pid):
    body = read("/proc/%s/stat" % pid)
    if not body or ")" not in body:
        return None
    rest = body.rsplit(")", 1)[1].split()
    try:
        return {"ticks": int(rest[11]) + int(rest[12]), "start": rest[19], "comm": body[body.find("(") + 1:body.rfind(")")]}
    except (IndexError, ValueError):
        return None


def proc_uid(pid):
    for line in (read("/proc/%s/status" % pid) or "").splitlines():
        if line.startswith("Uid:"):
            return line.split()[1]
    return None


def container_of(pid):
    m = re.search(r"([0-9a-f]{64})", read("/proc/%s/cgroup" % pid) or "")
    return m.group(1)[:12] if m else None


def exe_of(pid):
    try:
        return os.readlink(at("/proc/%s/exe" % pid))
    except OSError:
        return None  # a kernel thread, or not ours to read


def processes(found, state_file):
    pids = [n for n in listdir("/proc") if n.isdigit()]
    if not pids:
        return
    SCANNED.add("process")
    names = {u["uid"]: u["name"] for u in found}
    uptime = None
    try:
        uptime = float((read("/proc/uptime") or "").split()[0])
    except (IndexError, ValueError):
        pass
    try:
        tick = os.sysconf("SC_CLK_TCK")
    except (ValueError, OSError, AttributeError):
        tick = 100
    previous = {}
    if state_file:
        try:
            previous = json.load(open(state_file))
        except Exception:
            previous = {}
    elapsed = (uptime - previous.get("uptime", 0)) if uptime and previous.get("uptime") else 0
    now_ticks, grouped = {}, {}

    for pid in pids:
        st = proc_stat(pid)
        if not st:
            continue
        ident = "%s:%s" % (pid, st["start"])
        now_ticks[ident] = st["ticks"]
        raw = (read("/proc/%s/cmdline" % pid, 4096) or "").replace("\x00", " ").strip()
        exe = exe_of(pid)
        if exe is None and not raw:
            continue  # kernel threads have neither
        signs = []
        path = exe or ""
        deleted = path.endswith(" (deleted)")
        if deleted:
            path = path[: -len(" (deleted)")]
        if path.startswith(TEMP_DIRS):
            signs.append("temp")
        if deleted:
            # After a package update the old copy keeps running until it restarts: harmless. A program that
            # deleted its own file outside the system folders is hiding.
            signs.append("old-copy" if path.startswith(SYSTEM_DIRS) and os.path.exists(at(path)) else "deleted")
        if raw.startswith("[") and raw.rstrip().endswith("]") and exe:
            signs.append("fake-kernel")  # named like a kernel thread, but it is a program
        looking = st["comm"] in LOOKING_TOOLS or os.path.basename(path) in LOOKING_TOOLS
        if MINER_NAME.search(st["comm"]) or MINER_NAME.search(os.path.basename(path)) or (MINER_ARGS.search(raw) and not looking):
            signs.append("miner")
        parts = path.split("/")
        if len(parts) > 3 and parts[1] in ("home", "root") and not signs:
            hidden = [p for p in parts[2:-1] if p.startswith(".")]
            if hidden and not any(h in TOOL_DIRS for h in hidden):
                signs.append("hidden")
        busy = None
        if elapsed >= 60 and ident in previous.get("procs", {}):
            busy = round((st["ticks"] - previous["procs"][ident]) / float(tick) / elapsed * 100)
        uid = proc_uid(pid)
        info = {"pid": int(pid), "user": names.get(uid, uid), "command": redact(raw or st["comm"]), "container": container_of(pid)}
        what = path or st["comm"]
        if signs:
            g = grouped.setdefault(("proc", what), {"signs": set(), "runs": []})
            g["signs"].update(signs)
            g["runs"].append(info)
        if busy is not None and busy >= CPU_BUSY_PCT:
            g = grouped.setdefault(("cpu", what), {"signs": {"cpu"}, "runs": [], "cpuPct": 0})
            g["runs"].append(info)
            g["cpuPct"] = max(g["cpuPct"], busy)

    for (kind, what), g in sorted(grouped.items()):
        runs = sorted(g["runs"], key=lambda r: r["pid"])
        first = runs[0]
        detail = {"exe": what, "signs": sorted(g["signs"]), "pids": [r["pid"] for r in runs][:10], "count": len(runs), "user": first["user"],
                  "command": first["command"], "container": first["container"]}
        if kind == "cpu":
            detail["cpuPct"] = g["cpuPct"]
            detail["minutes"] = round(elapsed / 60)
        label = os.path.basename(what) or what
        add("process", "%s:%s" % (kind, what), label, detail, [what, sorted(g["signs"])])

    if state_file:
        try:
            tmp = state_file + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"uptime": uptime, "procs": now_ticks}, f)
            os.replace(tmp, state_file)
        except OSError:
            pass


# ── outgoing connections ────────────────────────────────────────────────────
# Remote ports that coin-mining pools and remote-control channels use. Ordinary web, mail and database
# traffic is not listed.

POOL_PORTS = {3333, 5555, 7777, 14433, 14444, 45560, 45700, 13333, 17777, 20580}
MAYBE_POOL_PORTS = {4444, 8888, 9999, 6666}
CHAT_PORTS = {6667, 6697, 7000}


def outbound(conn_file):
    if conn_file:
        out = open(conn_file).read()
    else:
        try:
            out = subprocess.run(["ss", "-H", "-tnp", "state", "established"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20).stdout.decode("utf-8", "replace")
        except Exception:
            return
    SCANNED.add("outbound")
    seen = {}
    for line in out.splitlines():
        f = line.split()
        # "ss state established" leaves out the state column; a full listing has it.
        if f and f[0] in ("ESTAB", "tcp"):
            f = f[1:] if f[0] == "ESTAB" else f[2:]
        if len(f) < 4:
            continue
        raddr, _, rport = f[3].rpartition(":")
        if not rport.isdigit():
            continue
        rport = int(rport)
        if rport not in POOL_PORTS | MAYBE_POOL_PORTS | CHAT_PORTS:
            continue
        raddr = raddr.strip("[]").split("%")[0]
        if raddr.startswith(("127.", "10.", "192.168.", "::1")) or re.match(r"^172\.(1[6-9]|2\d|3[01])\.", raddr):
            continue  # inside this server or its private network
        m = re.search(r'users:\(\("([^"]+)",pid=(\d+)', line)
        key = "out:%s:%d" % (raddr, rport)
        if key not in seen:
            seen[key] = {"remote": raddr, "port": rport, "program": m.group(1) if m else None, "pid": int(m.group(2)) if m else None,
                         "kind": "pool" if rport in POOL_PORTS else "maybe-pool" if rport in MAYBE_POOL_PORTS else "chat"}
    for key, d in sorted(seen.items()):
        add("outbound", key, "%s:%d" % (d["remote"], d["port"]), d, [d["program"]])


# ── containers ──────────────────────────────────────────────────────────────

RISKY_MOUNTS = ("/", "/etc", "/root", "/home", "/boot", "/proc", "/sys", "/dev", "/var/lib/docker", "/var/lib/containers")


def container_list(containers_file):
    if containers_file:
        return "file", json.load(open(containers_file))
    for runtime in ("docker", "podman"):
        try:
            ids = subprocess.run([runtime, "ps", "-aq", "--no-trunc"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        except Exception:
            continue
        if ids.returncode != 0:
            continue
        names = ids.stdout.decode().split()
        if not names:
            return runtime, []
        out = subprocess.run([runtime, "inspect"] + names[:500], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=40)
        try:
            return runtime, json.loads(out.stdout.decode("utf-8", "replace") or "[]")
        except ValueError:
            return None, None
    return None, None


def containers(containers_file):
    runtime, rows = container_list(containers_file)
    if rows is None:
        return
    SCANNED.add("container")
    for c in rows:
        name = (c.get("Name") or c.get("Id", "")[:12]).lstrip("/")
        cfg, host = c.get("Config") or {}, c.get("HostConfig") or {}
        labels = cfg.get("Labels") or {}
        mounts = []
        for m in c.get("Mounts") or []:
            src = m.get("Source") or m.get("Name") or ""
            if src:
                mounts.append(src)
        risky = sorted(set(m for m in mounts if m in RISKY_MOUNTS or m.endswith(("docker.sock", "podman.sock", "containerd.sock"))))
        site = labels.get("dbbkp.site")
        detail = {"name": name, "image": cfg.get("Image"), "running": bool((c.get("State") or {}).get("Running")), "runtime": runtime if runtime != "file" else "docker",
                  "privileged": bool(host.get("Privileged")), "hostNetwork": host.get("NetworkMode") == "host", "hostPid": host.get("PidMode") == "host",
                  "riskyMounts": risky, "site": site, "restart": (host.get("RestartPolicy") or {}).get("Name")}
        key = "container:app:%s" % site if site else "container:%s" % name
        add("container", key, name, detail, [detail["image"], detail["privileged"], detail["hostNetwork"], detail["hostPid"], risky])


def main():
    global ROOT
    ap = argparse.ArgumentParser(description="Read-only scan of this server for the Deploy King panel.")
    ap.add_argument("--out", default="-")
    ap.add_argument("--root", default="")
    ap.add_argument("--ss-file", default="")
    ap.add_argument("--ss-conn-file", default="")
    ap.add_argument("--containers-file", default="")
    ap.add_argument("--state", default=None, help="where to keep CPU counters between runs (default: next to --out)")
    a = ap.parse_args()
    ROOT = a.root.rstrip("/")
    found = users()
    admins(found)
    ssh_keys(found)
    sshd()
    cron()
    units(found)
    startup(found)
    ports(a.ss_file)
    state = a.state if a.state is not None else (os.path.join(os.path.dirname(os.path.abspath(a.out)), "cpu-state.json") if a.out != "-" else "")
    processes(found, state)
    outbound(a.ss_conn_file)
    containers(a.containers_file)
    report = {"version": 1, "generatedAt": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z", "hostname": socket.gethostname(),
              "asRoot": os.geteuid() == 0, "scanned": sorted(SCANNED), "items": ITEMS}
    text = json.dumps(report, separators=(",", ":"))
    if a.out == "-":
        print(text)
        return
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, a.out)  # the panel never reads half a report


if __name__ == "__main__":
    main()
