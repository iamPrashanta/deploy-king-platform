/**
 * Low-level SSH for "Servers": key pairs, fingerprints, connecting with a pinned host key, running commands.
 * Nothing in here touches the database; services/sshservers.ts does that.
 */
import net from "node:net";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { Client, utils, type ClientChannel, type ConnectConfig } from "ssh2";

export type KeyType = "ed25519" | "rsa4096" | "ecdsa";
export const KEY_TYPES: KeyType[] = ["ed25519", "rsa4096", "ecdsa"];
export const KEY_TYPE_LABEL: Record<string, string> = { ed25519: "Ed25519", rsa4096: "RSA 4096", rsa: "RSA", ecdsa: "ECDSA P-256" };

/** A label that is safe inside an authorized_keys line and a shell command. */
export const SAFE_LABEL = /^[A-Za-z0-9@._+-]{1,100}$/;
/** An address for from="...": IPv4/IPv6 with optional /prefix, or a host name pattern. No quotes, commas or spaces. */
export const SAFE_FROM = /^[A-Za-z0-9.:*?\/_-]{1,100}$/;

function blobOfLine(line: string): Buffer {
  const parts = line.trim().split(/\s+/);
  const b64 = parts.find((p) => /^AAAA[A-Za-z0-9+/=]+$/.test(p));
  if (!b64) throw new Error("Not an OpenSSH public key");
  return Buffer.from(b64, "base64");
}

/** SHA256 fingerprint the way `ssh-keygen -lf` prints it. */
export function fingerprintOfBlob(blob: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}
export const fingerprintOfLine = (line: string) => fingerprintOfBlob(blobOfLine(line));
export const blobBase64 = (line: string) => blobOfLine(line).toString("base64");

/** The key's algorithm name, read from the start of the public blob ("ssh-ed25519", "ecdsa-sha2-nistp256", ...). */
export function algoOfBlob(blob: Buffer): string {
  try {
    const n = blob.readUInt32BE(0);
    return blob.subarray(4, 4 + n).toString("ascii");
  } catch {
    return "unknown";
  }
}

/** "ED25519", "ECDSA", "RSA" as ssh-keygen shows host keys. */
export function hostKeyLabel(algo: string): string {
  if (algo.includes("ed25519")) return "ED25519";
  if (algo.startsWith("ecdsa")) return "ECDSA";
  if (algo.includes("rsa")) return "RSA";
  return algo.toUpperCase();
}

/**
 * A new key pair in OpenSSH format (ssh2's generator, on Node's crypto). ssh2 1.17 now and then writes an
 * Ed25519 private key it cannot read back (about 1 in 300), so every pair is read back, its public half compared
 * and a signature checked before it is used; a bad one is simply made again.
 */
export function generateKeyPair(type: KeyType, comment: string, passphrase?: string) {
  const enc: any = passphrase ? { passphrase, cipher: "aes256-ctr", rounds: 16 } : {};
  for (let attempt = 0; attempt < 10; attempt++) {
    const kp =
      type === "ed25519" ? utils.generateKeyPairSync("ed25519", { comment, ...enc })
      : type === "rsa4096" ? utils.generateKeyPairSync("rsa", { bits: 4096, comment, ...enc })
      : utils.generateKeyPairSync("ecdsa", { bits: 256, comment, ...enc });
    const publicKey = kp.public.trim();
    if (!usable(kp.private, publicKey, passphrase)) continue;
    return { privateKey: kp.private, publicKey, fingerprint: fingerprintOfLine(publicKey) };
  }
  throw new Error("Could not make a usable key pair. Try again.");
}

function usable(privateKey: string, publicLine: string, passphrase?: string): boolean {
  const parsed: any = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) return false;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.getPublicSSH().equals(blobOfLine(publicLine))) return false;
  const data = crypto.randomBytes(32);
  const sig = key.sign(data);
  return !(sig instanceof Error) && key.verify(data, sig) === true;
}

/** Reads a pasted private key. Returns its public line (with our label as the comment), fingerprint and type. */
export function inspectPrivateKey(text: string, label: string, passphrase?: string) {
  const parsed: any = utils.parseKey(text, passphrase || undefined);
  if (parsed instanceof Error) {
    if (/passphrase/i.test(parsed.message)) throw new Error(passphrase ? "The passphrase is wrong for this key." : "This key has a passphrase. Type it to import the key.");
    throw new Error("This is not a private key Deploy King can read (OpenSSH or PEM).");
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key?.isPrivateKey?.()) throw new Error("This is a public key. Paste the private half; the public half is worked out from it.");
  const blob: Buffer = key.getPublicSSH();
  const algo = algoOfBlob(blob);
  const type = algo === "ssh-ed25519" ? "ed25519" : algo.startsWith("ecdsa") ? "ecdsa" : algo === "ssh-rsa" ? (rsaBits(blob) === 4096 ? "rsa4096" : "rsa") : null;
  if (!type) throw new Error(`Keys of type ${algo} are not supported.`);
  return { type, publicKey: `${algo} ${blob.toString("base64")} ${label}`, fingerprint: fingerprintOfBlob(blob), hasPassphrase: !!passphrase };
}

function rsaBits(blob: Buffer): number {
  let o = 0;
  const next = () => { const n = blob.readUInt32BE(o); const v = blob.subarray(o + 4, o + 4 + n); o += 4 + n; return v; };
  next(); next(); // algo, e
  let n = next();
  while (n.length && n[0] === 0) n = n.subarray(1);
  return n.length * 8;
}

/** The authorized_keys line for a key, with its limits in front. */
export function authorizedLine(publicKey: string, opts: { from?: string | null; restrict?: boolean }) {
  const o: string[] = [];
  if (opts.from) o.push(`from="${opts.from}"`);
  if (opts.restrict) o.push("restrict", "pty");
  return (o.length ? o.join(",") + " " : "") + publicKey;
}

/** Adds a line to ~/.ssh/authorized_keys once. Every value in it was checked against SAFE_* above or is base64. */
export function addKeyScript(line: string, blob64: string) {
  return `umask 077; mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qF '${blob64}' ~/.ssh/authorized_keys || echo '${line}' >> ~/.ssh/authorized_keys)`;
}
/** What the admin pastes by hand (the design's "Run one command"). */
export function manualInstallCommand(line: string) {
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${line}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}
/** Removes every line holding this key. `cat >` keeps the file's owner and mode. */
export function removeKeyScript(blob64: string) {
  return `f=~/.ssh/authorized_keys; [ -f "$f" ] || exit 0; grep -vF '${blob64}' "$f" > "$f.dk-new"; cat "$f.dk-new" > "$f"; rm -f "$f.dk-new"; ! grep -qF '${blob64}' "$f"`;
}

// ─── Connecting ────────────────────────────────────────────────────────────────

export type Target = { host: string; port: number; username: string; timeoutSec?: number };
export type Auth = { privateKey: string; passphrase?: string } | { password: string };
export type HostKey = { type: string; fingerprint: string };
export type SshErrorCode = "timeout" | "refused" | "unreachable" | "auth" | "hostkey" | "passphrase" | "other";

export class SshError extends Error {
  constructor(public code: SshErrorCode, message: string, public seen?: HostKey) {
    super(message);
  }
}

/** Plain sentences for the design's "If the test fails" box. */
export function explain(code: SshErrorCode, t: Target, panelAddress?: string | null): string {
  switch (code) {
    case "timeout": return `Timed out: the firewall blocks ${panelAddress || "this panel"}, or nothing answers at ${t.host}:${t.port}.`;
    case "refused": return `Nothing answers on port ${t.port} at ${t.host}. Is SSH running on that port?`;
    case "unreachable": return `${t.host} cannot be reached from this panel. Check the address.`;
    case "auth": return `Permission denied: the key is not in authorized_keys for ${t.username}, or the password is wrong.`;
    case "hostkey": return "Wrong fingerprint: the server is not the one you trusted. Stop and check the address.";
    case "passphrase": return "The key's passphrase is wrong.";
    default: return "The connection failed.";
  }
}

function tcp(t: Target): Promise<{ sock: net.Socket; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host: t.host, port: t.port });
    const timer = setTimeout(() => { sock.destroy(); reject(new SshError("timeout", explain("timeout", t))); }, (t.timeoutSec ?? 10) * 1000);
    sock.once("connect", () => { clearTimeout(timer); resolve({ sock, ms: Date.now() - started }); });
    sock.once("error", (e: any) => {
      clearTimeout(timer);
      const code: SshErrorCode = e.code === "ECONNREFUSED" ? "refused" : e.code === "ETIMEDOUT" ? "timeout" : "unreachable";
      reject(new SshError(code, explain(code, t)));
    });
  });
}

export type ConnectOptions = {
  target: Target;
  auth: Auth;
  /** The fingerprint this server must show. null = first contact: accept and report what it showed. */
  expect: string | null;
  /** A stream to run SSH over instead of a new TCP connection (a jump server's forwarded port). */
  sock?: Duplex;
};

export type Connection = { client: Client; hostKey: HostKey; latencyMs: number | null };

export async function connect(o: ConnectOptions): Promise<Connection> {
  let sock: Duplex | undefined = o.sock;
  let latencyMs: number | null = null;
  if (!sock) {
    const c = await tcp(o.target);
    sock = c.sock;
    latencyMs = c.ms;
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen: HostKey | undefined;
    let rejectedHost = false;
    let done = false;
    const fail = (e: SshError) => { if (done) return; done = true; client.end(); sock?.destroy(); reject(e); };
    const cfg: ConnectConfig = {
      sock: sock as any,
      username: o.target.username,
      readyTimeout: (o.target.timeoutSec ?? 10) * 1000,
      keepaliveInterval: 30_000,
      algorithms: { serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] } as any,
      hostVerifier: (key: Buffer) => {
        seen = { type: hostKeyLabel(algoOfBlob(key)), fingerprint: fingerprintOfBlob(key) };
        if (o.expect && o.expect !== seen.fingerprint) { rejectedHost = true; return false; }
        return true;
      },
    } as ConnectConfig;
    if ("password" in o.auth) {
      cfg.password = o.auth.password;
      cfg.tryKeyboard = true;
      const pw = o.auth.password;
      client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => pw)));
    } else {
      cfg.privateKey = o.auth.privateKey;
      if (o.auth.passphrase) cfg.passphrase = o.auth.passphrase;
    }
    client.once("ready", () => { done = true; resolve({ client, hostKey: seen!, latencyMs }); });
    client.once("error", (e: any) => {
      if (rejectedHost) return fail(new SshError("hostkey", explain("hostkey", o.target), seen));
      if (/passphrase|Encrypted private/i.test(e.message)) return fail(new SshError("passphrase", explain("passphrase", o.target), seen));
      if (e.level === "client-authentication") return fail(new SshError("auth", explain("auth", o.target), seen));
      if (e.level === "client-timeout") return fail(new SshError("timeout", explain("timeout", o.target), seen));
      fail(new SshError("other", e.message || explain("other", o.target), seen));
    });
    try {
      client.connect(cfg);
    } catch (e: any) {
      fail(new SshError(/passphrase|Encrypted/i.test(e.message) ? "passphrase" : "other", /passphrase|Encrypted/i.test(e.message) ? explain("passphrase", o.target) : e.message));
    }
  });
}

/** Only shakes hands to learn the host key; nothing is sent to sign in. */
export async function probeHostKey(target: Target, sock?: Duplex): Promise<HostKey & { latencyMs: number | null }> {
  let s: Duplex | undefined = sock;
  let latencyMs: number | null = null;
  if (!s) { const c = await tcp(target); s = c.sock; latencyMs = c.ms; }
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen: HostKey | undefined;
    client.once("error", () => { client.end(); s?.destroy(); seen ? resolve({ ...seen, latencyMs }) : reject(new SshError("other", "The server did not show a host key.")); });
    client.connect({
      sock: s as any,
      username: target.username,
      readyTimeout: (target.timeoutSec ?? 10) * 1000,
      algorithms: { serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] } as any,
      hostVerifier: (key: Buffer) => { seen = { type: hostKeyLabel(algoOfBlob(key)), fingerprint: fingerprintOfBlob(key) }; return false; },
    } as ConnectConfig);
  });
}

/** Which sign-in methods the server offers this user (asks with "none", so nothing is tried). */
export async function offeredMethods(target: Target, expect: string | null, sock?: Duplex): Promise<string[] | null> {
  let s: Duplex | undefined = sock;
  if (!s) s = (await tcp(target)).sock;
  return new Promise((resolve) => {
    const client = new Client();
    let methods: string[] | null = null;
    const end = () => { client.end(); s?.destroy(); resolve(methods); };
    client.once("error", end);
    client.once("ready", end);
    client.connect({
      sock: s as any,
      username: target.username,
      readyTimeout: (target.timeoutSec ?? 10) * 1000,
      hostVerifier: (key: Buffer) => !expect || fingerprintOfBlob(key) === expect,
      authHandler: ((left: string[] | null, _partial: boolean, next: (m: any) => void) => {
        if (left === null) return next({ type: "none", username: target.username });
        methods = left;
        return next(false);
      }) as any,
    } as ConnectConfig);
  });
}

export type ExecResult = { code: number | null; stdout: string; stderr: string };

export function exec(client: Client, command: string, timeoutMs = 20_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { stream.close(); reject(new Error("The command took too long.")); }, timeoutMs);
      stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      stream.on("close", (code: number | null) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  });
}

export function shell(client: Client, cols: number, rows: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell({ term: "xterm-256color", cols, rows }, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/** Opens a forwarded stream to target through an already connected jump server. */
export function forwardThrough(jump: Client, target: Target): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    jump.forwardOut("127.0.0.1", 0, target.host, target.port, (err, stream) => {
      if (err) return reject(new SshError("unreachable", "The jump server would not forward the connection. Its key may be limited with no forwarding (restrict)."));
      resolve(stream);
    });
  });
}

/** One command that prints what the connection test and the Overview need, as key=value lines. */
export const FACTS_SCRIPT = [
  `. /etc/os-release 2>/dev/null; echo "os=\${PRETTY_NAME:-$(uname -s)}"`,
  `echo "cpus=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"`,
  `awk '/^MemTotal:/{print "memkb="$2} /^MemAvailable:/{print "memavailkb="$2}' /proc/meminfo`,
  `df -Pk / | awk 'NR==2{print "diskkb="$2; print "diskfreekb="$4}'`,
  `echo "uptime=$(cut -d. -f1 /proc/uptime)"`,
  `echo "load=$(cut -d' ' -f1 /proc/loadavg)"`,
  `a=$(head -1 /proc/stat); sleep 0.5; b=$(head -1 /proc/stat); echo "cpu1=$a"; echo "cpu2=$b"`,
  `if command -v docker >/dev/null 2>&1; then echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version 2>/dev/null | sed -E 's/^Docker version ([^,]+).*/\\1/')"; else echo "docker="; fi`,
  `if [ "$(id -u)" = 0 ]; then echo sudo=root; elif ! command -v sudo >/dev/null 2>&1; then echo sudo=none; elif sudo -n true 2>/dev/null; then echo sudo=nopass; else echo sudo=pass; fi`,
  `echo "client=$SSH_CLIENT"`,
].join("; ");

export function parseFacts(out: string) {
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const cpu = (s?: string) => (s ?? "").split(/\s+/).slice(1).map(Number).filter((n) => !Number.isNaN(n));
  const a = cpu(kv.cpu1), b = cpu(kv.cpu2);
  let cpuPct: number | undefined;
  if (a.length >= 4 && b.length >= 4) {
    const idle = (x: number[]) => x[3] + (x[4] ?? 0);
    const total = (x: number[]) => x.reduce((s, n) => s + n, 0);
    const dt = total(b) - total(a);
    cpuPct = dt > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - (idle(b) - idle(a)) / dt)))) : 0;
  }
  const num = (s?: string) => (s && !Number.isNaN(Number(s)) ? Number(s) : undefined);
  const memkb = num(kv.memkb), avail = num(kv.memavailkb), disk = num(kv.diskkb), free = num(kv.diskfreekb);
  return {
    os: kv.os || undefined,
    cpus: num(kv.cpus),
    memoryMb: memkb ? Math.round(memkb / 1024) : undefined,
    memoryUsedMb: memkb && avail != null ? Math.round((memkb - avail) / 1024) : undefined,
    diskTotalGb: disk ? Math.round(disk / 1024 / 1024) : undefined,
    diskFreeGb: free != null ? Math.round(free / 1024 / 1024) : undefined,
    uptimeSec: num(kv.uptime),
    load: num(kv.load),
    cpuPct,
    docker: kv.docker ? kv.docker : null,
    sudo: (["root", "nopass", "pass", "none"].includes(kv.sudo) ? kv.sudo : undefined) as "root" | "nopass" | "pass" | "none" | undefined,
    seenFrom: kv.client ? kv.client.split(/\s+/)[0] : undefined,
  };
}
