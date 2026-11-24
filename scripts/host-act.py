#!/usr/bin/env python3
"""Deploy King action helper.

Carries out what an admin chose on the Security page ("Remove" or "Undo") for things the host scan
found. The panel writes a request file; this helper, running as root on the server, reads it, checks
it, does it, and writes a result file the panel reads back.

The panel is never trusted with a command. A request names one of a fixed list of actions and a target,
and every target is checked again here: names must be plain, files must be the kind of file the action
works on, protected things (root, sshd, Docker, the platform itself) are refused. Before anything is
changed a copy is kept in a folder only root can read, so each action can be undone for 30 days.

    host-act.py --dir /opt/dbbkp/actions             handle waiting requests, refresh the heartbeat
    host-act.py --dir D --root R --state S --fake-commands F    (used by the checks)
"""
import argparse, base64, datetime, hashlib, ipaddress, json, os, re, shutil, stat, subprocess, sys, time

VERSION = 1
UNDO_DAYS = 30
ROOT = ""
FAKE = None  # file that receives the commands instead of running them (checks only)
MISSING = set(os.environ.get("FAKE_MISSING", "").split(","))

USER = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}$")
GROUP = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}$")
UNIT = re.compile(r"^[A-Za-z0-9@._:-]{1,120}\.(service|timer)$")
CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
HEX12 = re.compile(r"^[0-9a-f]{12}$")
ADMIN_GROUPS = ("sudo", "wheel", "admin", "docker", "lxd")
PROTECTED_USERS = {"root", "dbbkp"}
PROTECTED_UNITS = re.compile(r"^(ssh|sshd|docker|containerd|podman|dbus|cron|crond|systemd-.*|networking|network-manager|NetworkManager|ufw|firewalld|dbbkp.*|getty@.*|serial-getty@.*)\.(service|timer)$")
PROTECTED_EXES = ("/usr/sbin/sshd", "/usr/lib/systemd/systemd", "/lib/systemd/systemd", "/sbin/init", "/usr/bin/dockerd", "/usr/bin/containerd", "/usr/bin/podman")
CORE_CONTAINERS = {"dbbkp-postgres", "dbbkp-redis", "dbbkp-traefik", "dbbkp-api", "dbbkp-worker", "dbbkp-agent", "dbbkp-panel"}
SYSTEM_DIRS = ("/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/snap/")


class Refused(Exception):
    """The request is not acceptable. Nothing was changed."""


def at(path):
    return ROOT + path if ROOT else path


def digest(text):
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:32]


def read(path):
    with open(at(path), "r", errors="replace") as f:
        return f.read()


def have(tool):
    if FAKE:
        return tool not in MISSING
    return shutil.which(tool) is not None


def run(*argv, check=True):
    if FAKE:
        with open(FAKE, "a") as f:
            f.write(json.dumps(list(argv)) + "\n")
        return ""
    p = subprocess.run(list(argv), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if check and p.returncode != 0:
        raise RuntimeError("%s failed: %s" % (argv[0], (p.stderr or p.stdout).decode("utf-8", "replace").strip()[:300]))
    return p.stdout.decode("utf-8", "replace")


def rewrite(path, text):
    """Replace a file in one step, keeping its owner and mode. cron and sshd notice the change."""
    full = at(path)
    st = os.stat(full)
    tmp = full + ".dk-tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, stat.S_IMODE(st.st_mode))
    try:
        os.chown(tmp, st.st_uid, st.st_gid)
    except PermissionError:
        pass  # only in the checks, which do not run as root
    os.replace(tmp, full)


def passwd():
    rows = {}
    for line in read("/etc/passwd").splitlines():
        f = line.split(":")
        if len(f) >= 7:
            rows[f[0]] = {"uid": f[2], "home": f[5], "shell": f[6]}
    return rows


def real_inside(path, allowed):
    """The file's real location (symlinks followed) must be one of the allowed ones."""
    if not isinstance(path, str) or "\x00" in path or not path.startswith("/"):
        raise Refused("not a file path")
    real = os.path.realpath(at(path))
    rel = real[len(ROOT):] if ROOT and real.startswith(ROOT) else real
    if not any(rel == a or (a.endswith("/") and rel.startswith(a) and "/" not in rel[len(a):]) for a in allowed):
        raise Refused("%s is not a file this action works on" % path)
    if not os.path.isfile(at(rel)):
        raise Refused("%s no longer exists" % path)
    return rel


def norm(line):
    return " ".join(line.split())


# ── the actions ─────────────────────────────────────────────────────────────
# Each takes the target and the backup folder, does the change, and returns (message, undo data).

def lock_user(t, bak):
    user = t.get("user")
    if not isinstance(user, str) or not USER.match(user) or user in PROTECTED_USERS:
        raise Refused("this account cannot be locked from the panel")
    pw = passwd().get(user)
    if not pw:
        raise Refused("there is no account called %s" % user)
    if pw["uid"] == "0":
        raise Refused("an account with user id 0 must be fixed by hand")
    locked = any(l.startswith(user + ":!") for l in read("/etc/shadow").splitlines()) if os.path.exists(at("/etc/shadow")) else False
    run("usermod", "-L", "-s", "/usr/sbin/nologin", user)
    run("pkill", "-KILL", "-u", user, check=False)
    return "Locked %s and ended its sessions." % user, {"user": user, "shell": pw["shell"], "wasLocked": locked}


def undo_lock_user(u):
    if u["wasLocked"]:
        run("usermod", "-s", u["shell"], u["user"])
    else:
        run("usermod", "-U", "-s", u["shell"], u["user"])
    return "Unlocked %s and gave it its shell back." % u["user"]


def remove_group(t, bak):
    user, group = t.get("user"), t.get("group")
    if not (isinstance(user, str) and USER.match(user) and isinstance(group, str) and group in ADMIN_GROUPS) or user in PROTECTED_USERS:
        raise Refused("only membership of an admin group can be removed")
    members = []
    for line in read("/etc/group").splitlines():
        f = line.split(":")
        if len(f) >= 4 and f[0] == group:
            members = [m for m in f[3].split(",") if m]
    if user not in members:
        raise Refused("%s is not listed in the %s group (it may be its main group; fix that by hand)" % (user, group))
    run("gpasswd", "-d", user, group)
    return "Took %s out of the %s group. It applies from their next sign-in." % (user, group), {"user": user, "group": group}


def undo_remove_group(u):
    run("gpasswd", "-a", u["user"], u["group"])
    return "Put %s back in the %s group." % (u["user"], u["group"])


def drop_lines(path, bak, keep):
    """Rewrite a file without the lines `keep` rejects. The original is kept for undo."""
    original = read(path)
    lines = original.splitlines(True)
    kept = [l for l in lines if keep(l)]
    if len(kept) == len(lines):
        raise Refused("that line is no longer in %s" % path)
    shutil.copy2(at(path), os.path.join(bak, "original"))
    text = "".join(kept)
    rewrite(path, text)
    return {"file": path, "after": digest(text), "removed": [l for l in lines if not keep(l)]}


def undo_lines(u, bak):
    current = read(u["file"])
    if digest(current) == u["after"]:
        rewrite(u["file"], open(os.path.join(bak, "original")).read())
        return "Put %s back as it was." % u["file"]
    # Changed since: add the removed lines back rather than overwrite someone else's edit.
    rewrite(u["file"], current + ("" if current.endswith("\n") or not current else "\n") + "".join(u["removed"]))
    return "Added the removed line back to %s (the file had been changed since, so the rest was left as it is)." % u["file"]


def key_fingerprint(line):
    tok = line.strip().split()
    for i, t in enumerate(tok):
        if re.match(r"^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+@openssh\.com)$", t) and i + 1 < len(tok):
            try:
                return "SHA256:" + base64.b64encode(hashlib.sha256(base64.b64decode(tok[i + 1])).digest()).decode().rstrip("=")
            except Exception:
                return None
    return None


def remove_ssh_key(t, bak):
    user, fp, path = t.get("user"), t.get("fingerprint"), t.get("file")
    if not (isinstance(user, str) and USER.match(user) and isinstance(fp, str) and fp.startswith("SHA256:")):
        raise Refused("not a key this action can remove")
    pw = passwd().get(user)
    if not pw or pw["home"] in ("", "/"):
        raise Refused("there is no account called %s" % user)
    home = pw["home"].rstrip("/")
    path = real_inside(path, [home + "/.ssh/authorized_keys", home + "/.ssh/authorized_keys2"])
    u = drop_lines(path, bak, lambda l: key_fingerprint(l) != fp)
    return "Removed the key %s from %s." % (fp[:20] + "...", path), u


def remove_cron_line(t, bak):
    path, h = t.get("file"), t.get("lineHash")
    if not (isinstance(h, str) and HEX12.match(h)):
        raise Refused("not a scheduled job this action can remove")
    path = real_inside(path, ["/etc/crontab", "/etc/cron.d/", "/var/spool/cron/crontabs/", "/var/spool/cron/"])
    u = drop_lines(path, bak, lambda l: digest(norm(l))[:12] != h or not norm(l))
    return "Removed the scheduled job from %s." % path, u


def disable_cron_script(t, bak):
    path = real_inside(t.get("file"), ["/etc/cron.hourly/", "/etc/cron.daily/", "/etc/cron.weekly/", "/etc/cron.monthly/"])
    mode = stat.S_IMODE(os.stat(at(path)).st_mode)
    os.chmod(at(path), mode & ~0o111)
    return "%s no longer runs (it is kept, without permission to run)." % path, {"file": path, "mode": mode}


def undo_cron_script(u):
    os.chmod(at(u["file"]), u["mode"])
    return "%s runs on its schedule again." % u["file"]


def remove_sudo_rule(t, bak):
    path, h = t.get("file"), t.get("ruleHash")
    if not (isinstance(h, str) and HEX12.match(h)):
        raise Refused("not a sudo rule this action can remove")
    path = real_inside(path, ["/etc/sudoers", "/etc/sudoers.d/"])
    original = read(path)
    new = "".join(l for l in original.splitlines(True) if digest(norm(l))[:12] != h)
    if new == original:
        raise Refused("that rule is no longer in %s" % path)
    if have("visudo") and not FAKE:
        check = at(path) + ".dk-check"
        open(check, "w").write(new)
        try:
            run("visudo", "-cf", check)
        finally:
            os.remove(check)
    shutil.copy2(at(path), os.path.join(bak, "original"))
    rewrite(path, new)
    return "Removed the sudo rule from %s." % path, {"file": path, "after": digest(new), "removed": [l for l in original.splitlines(True) if digest(norm(l))[:12] == h]}


def disable_unit(t, bak):
    name, path, origin = t.get("name"), t.get("file"), t.get("origin")
    if not (isinstance(name, str) and UNIT.match(name)) or PROTECTED_UNITS.match(name):
        raise Refused("%s cannot be stopped from the panel" % name)
    if origin == "home":
        user = t.get("user")
        pw = passwd().get(user) if isinstance(user, str) and USER.match(user) else None
        if not pw:
            raise Refused("unknown user for this service")
        path = real_inside(path, [pw["home"].rstrip("/") + "/.config/systemd/user/" + name])
        shutil.move(at(path), os.path.join(bak, name))
        return "Moved %s out of %s's folder; it no longer starts when they sign in." % (name, user), {"name": name, "file": path, "moved": True, "origin": origin}
    enabled = False
    try:
        enabled = run("systemctl", "is-enabled", name, check=False).strip() == "enabled" if not FAKE else bool(t.get("enabled"))
    except Exception:
        pass
    run("systemctl", "disable", "--now", name, check=False)
    moved = False
    if origin == "admin":
        path = real_inside(path, ["/etc/systemd/system/" + name, "/etc/systemd/user/" + name])
        shutil.move(at(path), os.path.join(bak, name))
        moved = True
        run("systemctl", "daemon-reload")
    return "Stopped %s and kept it from starting again%s." % (name, "; its file is kept for undo" if moved else ""), {"name": name, "file": path, "moved": moved, "enabled": enabled, "origin": origin}


def undo_unit(u, bak):
    if u["moved"]:
        if os.path.exists(at(u["file"])):
            raise Refused("%s exists again, so it was not overwritten" % u["file"])
        shutil.move(os.path.join(bak, u["name"]), at(u["file"]))
    if u["origin"] == "home":
        return "Put %s back; it starts the next time that user signs in." % u["name"]
    run("systemctl", "daemon-reload")
    if u.get("enabled"):
        run("systemctl", "enable", u["name"], check=False)
    run("systemctl", "start", u["name"], check=False)
    return "Started %s again%s." % (u["name"], " and set it to start at boot" if u.get("enabled") else "")


def stop_process(t, bak):
    exe, pids = t.get("exe"), t.get("pids")
    if not (isinstance(exe, str) and exe.startswith("/")) or exe in PROTECTED_EXES:
        raise Refused("this program cannot be stopped from the panel")
    if not isinstance(pids, list) or not pids or not all(isinstance(p, int) and p > 1 for p in pids):
        raise Refused("no process to stop")
    mine = []
    for pid in pids[:20]:
        try:
            link = os.readlink(at("/proc/%d/exe" % pid))
        except OSError:
            continue  # already gone
        if link.replace(" (deleted)", "") == exe:  # the number may belong to another program by now
            mine.append(pid)
    if not mine:
        raise Refused("it is no longer running")
    # Inside a container the path names a file in the container, not on the server: never touch the server's file.
    in_container = bool(t.get("container"))
    run("kill", "-STOP", *[str(p) for p in mine])
    src = at(exe) if os.path.isfile(at(exe)) and not in_container else at("/proc/%d/exe" % mine[0])
    kept = os.path.join(bak, "program")
    try:
        shutil.copyfile(src, kept)
        os.chmod(kept, 0)
    except OSError:
        kept = None
    run("kill", "-KILL", *[str(p) for p in mine])
    quarantined = None
    # Take the file away too, unless it is part of the system: then the system itself needs fixing.
    if os.path.isfile(at(exe)) and not exe.startswith(SYSTEM_DIRS) and not in_container:
        quarantined = {"file": exe, "mode": stat.S_IMODE(os.stat(at(exe)).st_mode)}
        shutil.move(at(exe), os.path.join(bak, "quarantined"))
        os.chmod(os.path.join(bak, "quarantined"), 0)
    msg = "Stopped %d process%s of %s" % (len(mine), "" if len(mine) == 1 else "es", exe)
    msg += "; the program file was moved to quarantine." if quarantined else "; a copy of the program was kept for later." if kept else "."
    return msg, {"exe": exe, "quarantined": quarantined}


def undo_process(u, bak):
    q = u.get("quarantined")
    if not q:
        return "Nothing to put back: the program file was not moved. A stopped process cannot be started again from here."
    if os.path.exists(at(q["file"])):
        raise Refused("%s exists again, so it was not overwritten" % q["file"])
    shutil.move(os.path.join(bak, "quarantined"), at(q["file"]))
    os.chmod(at(q["file"]), q["mode"])
    return "Put %s back. The process is not started again." % q["file"]


def block_address(t, bak):
    try:
        ip = ipaddress.ip_address(t.get("ip", ""))
    except ValueError:
        raise Refused("not an address")
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        raise Refused("addresses inside this server's network are not blocked from the panel")
    ip = str(ip)
    if have("ufw"):
        run("ufw", "insert", "1", "deny", "out", "to", ip, "comment", "deploy-king")
        return "Blocked connections to %s (firewall: ufw)." % ip, {"ip": ip, "tool": "ufw"}
    tool = "ip6tables" if ":" in ip else "iptables"
    if not have(tool):
        raise Refused("there is no firewall tool (ufw or %s) on this server" % tool)
    run(tool, "-I", "OUTPUT", "-d", ip, "-j", "DROP", "-m", "comment", "--comment", "deploy-king")
    return "Blocked connections to %s (firewall: %s). The rule lasts until the next reboot unless you save it." % (ip, tool), {"ip": ip, "tool": tool}


def undo_block(u):
    if u["tool"] == "ufw":
        run("ufw", "delete", "deny", "out", "to", u["ip"])
    else:
        run(u["tool"], "-D", "OUTPUT", "-d", u["ip"], "-j", "DROP", "-m", "comment", "--comment", "deploy-king")
    return "Connections to %s are allowed again." % u["ip"]


def stop_container(t, bak):
    name, rt = t.get("name"), t.get("runtime")
    rt = rt if rt in ("docker", "podman") else "docker"
    if not (isinstance(name, str) and CONTAINER.match(name)) or name in CORE_CONTAINERS:
        raise Refused("this container cannot be stopped from the panel")
    restart = t.get("restart") if t.get("restart") in ("no", "always", "unless-stopped", "on-failure") else "no"
    run(rt, "update", "--restart=no", name)
    run(rt, "stop", name)
    return "Stopped container %s and kept it from starting again. It is kept, so you can look inside it." % name, {"name": name, "runtime": rt, "restart": restart}


def undo_container(u):
    run(u["runtime"], "update", "--restart=" + u["restart"], u["name"])
    run(u["runtime"], "start", u["name"])
    return "Started container %s again." % u["name"]


ACTIONS = {
    "lock-user": (lock_user, lambda u, b: undo_lock_user(u)),
    "remove-group": (remove_group, lambda u, b: undo_remove_group(u)),
    "remove-ssh-key": (remove_ssh_key, undo_lines),
    "remove-cron-line": (remove_cron_line, undo_lines),
    "disable-cron-script": (disable_cron_script, lambda u, b: undo_cron_script(u)),
    "remove-sudo-rule": (remove_sudo_rule, undo_lines),
    "disable-unit": (disable_unit, undo_unit),
    "stop-process": (stop_process, undo_process),
    "block-address": (block_address, lambda u, b: undo_block(u)),
    "stop-container": (stop_container, lambda u, b: undo_container(u)),
}

ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.undo)?$")


def now():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def handle(req, state):
    rid = req.get("id")
    if not isinstance(rid, str) or not ID.match(rid):
        raise Refused("bad request id")
    action = req.get("action")
    if action == "undo":
        of = rid[: -len(".undo")]
        bak = os.path.join(state, of)
        try:
            meta = json.load(open(os.path.join(bak, "meta.json")))
        except Exception:
            raise Refused("there is nothing to undo for this action")
        if meta.get("undone"):
            raise Refused("this was already undone")
        age = time.time() - meta.get("time", 0)
        if age > UNDO_DAYS * 86400:
            raise Refused("undo is only possible for %d days" % UNDO_DAYS)
        message = ACTIONS[meta["action"]][1](meta["undo"], bak)
        meta["undone"] = now()
        json.dump(meta, open(os.path.join(bak, "meta.json"), "w"))
        return message, False
    if action not in ACTIONS:
        raise Refused("unknown action")
    target = req.get("target")
    if not isinstance(target, dict):
        raise Refused("no target")
    bak = os.path.join(state, rid)
    if os.path.exists(bak):
        raise Refused("this request was already carried out")
    os.makedirs(bak, mode=0o700)
    try:
        message, undo = ACTIONS[action][0](target, bak)
    except BaseException:
        shutil.rmtree(bak, ignore_errors=True)
        raise
    json.dump({"action": action, "target": target, "undo": undo, "time": time.time(), "at": now(), "by": str(req.get("requestedBy", ""))[:60]},
              open(os.path.join(bak, "meta.json"), "w"))
    return message, True


def write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    global ROOT, FAKE
    ap = argparse.ArgumentParser(description="Carry out Remove and Undo requests from the Deploy King panel.")
    ap.add_argument("--dir", default="/opt/dbbkp/actions", help="holds requests/ (written by the panel) and results/ (read by it)")
    ap.add_argument("--state", default="/var/lib/dbbkp-actions", help="copies kept for undo; root only")
    ap.add_argument("--root", default="")
    ap.add_argument("--fake-commands", default=None)
    a = ap.parse_args()
    ROOT, FAKE = a.root.rstrip("/"), a.fake_commands
    requests, results = os.path.join(a.dir, "requests"), os.path.join(a.dir, "results")
    os.makedirs(requests, exist_ok=True)
    os.makedirs(results, exist_ok=True)
    os.makedirs(a.state, mode=0o700, exist_ok=True)
    os.chmod(a.state, 0o700)

    for name in sorted(os.listdir(requests)):
        path = os.path.join(requests, name)
        if not name.endswith(".json") or not os.path.isfile(path) or os.path.islink(path):
            continue
        result = {"id": name[:-5], "at": now(), "ok": False, "undoable": False}
        try:
            st = os.lstat(path)
            if st.st_size > 64 * 1024:
                raise Refused("request too large")
            # Only root (the panel's container) writes requests. Anything else in the folder is ignored.
            if not FAKE and st.st_uid != 0:
                raise Refused("the request file is not owned by root")
            req = json.load(open(path))
            if not isinstance(req, dict) or req.get("version") != 1 or req.get("id") != name[:-5]:
                raise Refused("not a request this helper understands")
            message, undoable = handle(req, a.state)
            result.update(ok=True, message=message, undoable=undoable)
        except Refused as e:
            result["message"] = "Not done: %s. Nothing was changed." % e
        except Exception as e:
            result["message"] = "Failed: %s" % str(e)[:300]
        if ID.match(result["id"]):
            write_json(os.path.join(results, result["id"] + ".json"), result)
        os.remove(path)

    cutoff = time.time() - (UNDO_DAYS + 10) * 86400
    for name in os.listdir(results):
        p = os.path.join(results, name)
        if name != "helper.json" and os.path.getmtime(p) < cutoff:
            os.remove(p)
    write_json(os.path.join(results, "helper.json"), {"version": VERSION, "at": now(), "actions": sorted(ACTIONS), "undoDays": UNDO_DAYS})


if __name__ == "__main__":
    main()
