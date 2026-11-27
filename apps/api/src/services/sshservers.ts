/**
 * Servers & SSH: the rules around servers, keys and trust. Used by the tRPC router (servers.router.ts)
 * and the terminal WebSocket (ws/ssh.ts).
 *
 * - Private keys and stored passwords are encrypted with MASTER_KEY and never returned by the API.
 * - A one-time password (install a key for me) is used for that one connection and never stored.
 * - Trust on first use: the first host key a server shows is pinned; the admin confirms it;
 *   any later connection that shows another key is refused and the server is marked.
 */
import { TRPCError } from "@trpc/server";
import { eq, and, ne, inArray } from "drizzle-orm";
import { db, platformSettings, sshKeys, sshServers, type SshAccessRules, type SshKey, type SshServer, type SshSystemInfo } from "@dbbkp/db";
import { encrypt, decrypt } from "@dbbkp/security";
import { logAudit, type AuditAction } from "@dbbkp/audit";
import {
  type Auth, type Connection, type KeyType, SshError, SAFE_FROM, SAFE_LABEL, addKeyScript, authorizedLine, blobBase64, connect, exec, explain,
  FACTS_SCRIPT, forwardThrough, generateKeyPair, manualInstallCommand, offeredMethods, parseFacts, probeHostKey, removeKeyScript, KEY_TYPE_LABEL,
} from "./ssh";

// ─── Settings (the SSH keys page's "Security defaults") ───────────────────────
export type SshSettings = {
  keyType: KeyType;
  rotateDays: number | null; // null = never
  lockToPanel: boolean;
  askPassword: boolean;
  record: boolean;
  allowPasswordSignIn: boolean;
  panelAddress: string | null; // this panel's address as servers see it, for from="..."
  seenAddress?: string | null; // learned from $SSH_CLIENT on the last connection
};
const SETTINGS_KEY = "ssh";
export const DEFAULT_SETTINGS: SshSettings = { keyType: "ed25519", rotateDays: 90, lockToPanel: true, askPassword: true, record: true, allowPasswordSignIn: true, panelAddress: null, seenAddress: null };

export async function getSettings(): Promise<SshSettings> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, SETTINGS_KEY)).limit(1);
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<SshSettings>) ?? {}) };
}
export async function saveSettings(value: SshSettings, userId?: string) {
  await db.insert(platformSettings).values({ key: SETTINGS_KEY, value, updatedBy: userId ?? null })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId ?? null, updatedAt: new Date() } });
}
async function rememberSeenAddress(addr: string | undefined) {
  if (!addr || !SAFE_FROM.test(addr)) return;
  const s = await getSettings();
  if (s.seenAddress !== addr) await saveSettings({ ...s, seenAddress: addr });
}
/** The address keys are locked to: the one set by the admin, else the environment, else the one servers last saw. */
export function lockAddress(s: SshSettings): string | null {
  return s.panelAddress || process.env.DK_PANEL_ADDRESS || s.seenAddress || null;
}

export function defaultRules(s: SshSettings): SshAccessRules {
  return { adminsOnly: true, askPassword: s.askPassword, record: s.record, idleMinutes: 15, allowAutomation: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export const notFound = (what = "Server") => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
export const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

export async function loadServer(id: string): Promise<SshServer> {
  const [s] = await db.select().from(sshServers).where(eq(sshServers.id, id)).limit(1);
  if (!s) throw notFound();
  return s;
}
export async function loadKey(id: string): Promise<SshKey> {
  const [k] = await db.select().from(sshKeys).where(eq(sshKeys.id, id)).limit(1);
  if (!k) throw notFound("Key");
  return k;
}

export type Actor = { id: string; username?: string; ip?: string | null };
export function audit(action: AuditAction, actor: Actor, target: { id?: string; type?: string; name?: string }, metadata?: Record<string, any>) {
  return logAudit(action, { actorId: actor.id, targetId: target.id, targetType: target.type ?? "ssh_server", targetName: target.name, metadata, ip: actor.ip ?? undefined });
}

/** A server as the panel sees it: never any secret. */
export function publicServer(s: SshServer, key?: SshKey | null) {
  return {
    id: s.id, name: s.name, host: s.host, port: s.port, username: s.username, authMethod: s.authMethod,
    hasPassword: !!s.encryptedPassword,
    key: key ? publicKey(key) : null,
    hostKey: s.hostKeyFingerprint ? { type: s.hostKeyType, fingerprint: s.hostKeyFingerprint, trustedAt: s.hostKeyTrustedAt } : null,
    seenHostKey: s.seenHostKeyFingerprint ? { type: s.seenHostKeyType, fingerprint: s.seenHostKeyFingerprint } : null,
    rules: s.rules, status: s.status, statusNote: s.statusNote, system: s.system, timeoutSec: s.timeoutSec, jumpServerId: s.jumpServerId,
    setupDone: s.setupDone, lastCheckAt: s.lastCheckAt, lastUsedAt: s.lastUsedAt, createdAt: s.createdAt,
  };
}
export function publicKey(k: SshKey) {
  const ageDays = Math.floor((Date.now() - new Date(k.createdAt).getTime()) / 86_400_000);
  return {
    id: k.id, label: k.label, type: k.type, typeLabel: KEY_TYPE_LABEL[k.type] ?? k.type, publicKey: k.publicKey, fingerprint: k.fingerprint,
    hasPassphrase: k.hasPassphrase, imported: k.imported, fromAddress: k.fromAddress, restrict: k.restrict, rotateAfterDays: k.rotateAfterDays,
    createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, ageDays,
    rotateInDays: k.rotateAfterDays == null ? null : k.rotateAfterDays - ageDays,
  };
}

function decryptKey(k: SshKey) {
  return decrypt({ encryptedValue: k.encryptedPrivateKey, iv: k.iv, authTag: k.authTag });
}

// ─── Keys ─────────────────────────────────────────────────────────────────────
export async function createKey(opts: { type: KeyType; label: string; passphrase?: string; lock: boolean; restrict: boolean; rotateDays: number | null; actor: Actor; rotatedFromId?: string }) {
  if (!SAFE_LABEL.test(opts.label)) throw bad("A label may use letters, digits and @ . _ + - only, without spaces.");
  const s = await getSettings();
  const from = opts.lock ? lockAddress(s) : null;
  const kp = generateKeyPair(opts.type, opts.label, opts.passphrase);
  const enc = encrypt(kp.privateKey);
  const [row] = await db.insert(sshKeys).values({
    label: opts.label, type: opts.type, publicKey: kp.publicKey, fingerprint: kp.fingerprint,
    encryptedPrivateKey: enc.encryptedValue, iv: enc.iv, authTag: enc.authTag, hasPassphrase: !!opts.passphrase,
    // A lock was asked for even when the address is not known yet: it is filled in at install from $SSH_CLIENT.
    fromAddress: opts.lock ? from ?? "" : null,
    restrict: opts.restrict, rotateAfterDays: opts.rotateDays, rotatedFromId: opts.rotatedFromId ?? null, createdBy: opts.actor.id,
  }).returning();
  audit("ssh_key_create", opts.actor, { id: row.id, type: "ssh_key", name: row.label }, { type: row.type, fingerprint: row.fingerprint, locked: opts.lock, restrict: opts.restrict, rotatedFrom: opts.rotatedFromId });
  return row;
}

/** The line for authorized_keys, the command to paste, and whether the lock address is still unknown. */
export function installInfo(k: SshKey) {
  const line = authorizedLine(k.publicKey, { from: k.fromAddress || null, restrict: k.restrict });
  return { line, command: manualInstallCommand(line), lockPending: k.fromAddress === "" };
}

// ─── Connecting to a server ───────────────────────────────────────────────────
async function authFor(s: SshServer, passphrase?: string): Promise<Auth> {
  if (s.authMethod === "password") {
    if (!s.encryptedPassword) throw new SshError("auth", "No password is stored for this server yet.");
    return { password: decrypt({ encryptedValue: s.encryptedPassword, iv: s.passwordIv!, authTag: s.passwordAuthTag! }) };
  }
  if (!s.keyId) throw new SshError("auth", "This server has no SSH key yet. Finish the setup first.");
  const k = await loadKey(s.keyId);
  if (k.hasPassphrase && !passphrase) throw new SshError("passphrase", "This key has a passphrase. Type it to connect.");
  return { privateKey: decryptKey(k), passphrase };
}

const target = (s: SshServer) => ({ host: s.host, port: s.port, username: s.username, timeoutSec: s.timeoutSec });

async function viaJump(s: SshServer, depth: number) {
  if (!s.jumpServerId) return { sock: undefined, jump: undefined };
  if (depth > 2) throw new SshError("other", "Jump servers are chained too deep.");
  const j = await loadServer(s.jumpServerId);
  const jc = await openServer(j, { requireTrusted: true, depth: depth + 1 });
  const sock = await forwardThrough(jc.client, target(s));
  return { sock, jump: jc.client };
}

/**
 * Connects to a server with its own sign-in. The host key must match the trusted one, or before trust,
 * the one it showed the first time. A mismatch is refused, recorded on the server and audited.
 */
export async function openServer(
  s: SshServer,
  o: { passphrase?: string; auth?: Auth; requireTrusted?: boolean; actor?: Actor; depth?: number } = {},
): Promise<Connection> {
  if (o.requireTrusted && !s.hostKeyFingerprint) throw new SshError("hostkey", "Confirm the server's fingerprint first (Add server, step 3).");
  const expect = s.hostKeyFingerprint ?? s.seenHostKeyFingerprint ?? null;
  const auth = o.auth ?? (await authFor(s, o.passphrase));
  const { sock, jump } = await viaJump(s, o.depth ?? 0);
  try {
    const c = await connect({ target: target(s), auth, expect, sock });
    if (jump) c.client.once("close", () => jump.end());
    const now = new Date();
    await db.update(sshServers).set({
      lastUsedAt: now,
      ...(expect ? {} : { seenHostKeyType: c.hostKey.type, seenHostKeyFingerprint: c.hostKey.fingerprint }),
    }).where(eq(sshServers.id, s.id));
    if (!o.auth && s.keyId) await db.update(sshKeys).set({ lastUsedAt: now }).where(eq(sshKeys.id, s.keyId));
    return c;
  } catch (e) {
    jump?.end();
    if (e instanceof SshError && e.code === "hostkey" && e.seen) {
      const was = expect!;
      const note = `The server's fingerprint changed from ${was} to ${e.seen.fingerprint}. Deploy King refused to connect.`;
      await db.update(sshServers).set({ status: "host_key_changed", statusNote: note, updatedAt: new Date() }).where(eq(sshServers.id, s.id));
      audit("ssh_host_refused", o.actor ?? { id: undefined as any }, { id: s.id, name: s.name }, { expected: was, shown: e.seen.fingerprint, trusted: !!s.hostKeyFingerprint });
    }
    throw e;
  }
}

export type Check = { key: string; state: "ok" | "warn" | "bad" | "info"; title: string; detail: string; command?: string };

const DISABLE_PASSWORD_CMD = `sudo sed -i -E 's/^#?\\s*PasswordAuthentication\\s+.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo sshd -t && (sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd)`;

/** The design's "Connection test". Updates the server's status and system facts. */
export async function runChecks(s: SshServer, o: { passphrase?: string; actor: Actor }) {
  const checks: Check[] = [];
  const t = target(s);
  const settings = await getSettings();
  const sys: SshSystemInfo = { ...(s.system ?? {}) };
  let status = s.status;
  let note: string | null = null;
  try {
    // 1. Reachable
    if (!s.jumpServerId) {
      const p = await probeHostKey(t);
      sys.latencyMs = p.latencyMs ?? undefined;
      checks.push({ key: "reach", state: "ok", title: `Reachable on port ${s.port}`, detail: `Answered in ${p.latencyMs} ms.` });
    } else {
      checks.push({ key: "reach", state: "ok", title: `Reachable through the jump server`, detail: "Port forwarded by the jump server." });
    }
    // 2. Signed in
    const c = await openServer(s, { passphrase: o.passphrase, actor: o.actor });
    try {
      const key = s.keyId && s.authMethod !== "password" ? await loadKey(s.keyId) : null;
      checks.push(key
        ? { key: "auth", state: "ok", title: `Signed in as ${s.username} with the key`, detail: `${KEY_TYPE_LABEL[key.type] ?? key.type} · ${key.fingerprint.slice(0, 11)}…${key.fingerprint.slice(-4)}` }
        : { key: "auth", state: "warn", title: `Signed in as ${s.username} with the stored password`, detail: "Less safe: switch to a key." });
      // 3. System
      const r = await exec(c.client, FACTS_SCRIPT);
      const f = parseFacts(r.stdout);
      Object.assign(sys, f);
      if (f.seenFrom) await rememberSeenAddress(f.seenFrom);
      checks.push({ key: "system", state: "ok", title: f.os ?? "Unknown system", detail: [f.cpus && `${f.cpus} vCPU`, f.memoryMb && `${Math.round(f.memoryMb / 1024)} GB memory`, f.diskFreeGb != null && `${f.diskFreeGb} GB free disk`].filter(Boolean).join(" · ") });
      // 4. Password sign-in still on?
      const methods = await offeredMethods(t, c.hostKey.fingerprint).catch(() => null);
      sys.passwordAuth = methods ? methods.includes("password") || methods.includes("keyboard-interactive") : null;
      if (s.authMethod !== "password") {
        if (sys.passwordAuth) checks.push({ key: "password", state: "warn", title: "Password sign-in is still on", detail: "Now that the key works, turn it off so nobody can guess the password.", command: DISABLE_PASSWORD_CMD });
        else if (sys.passwordAuth === false) checks.push({ key: "password", state: "ok", title: "Password sign-in is off", detail: "Only keys can sign in to this server." });
      }
      // 5. sudo
      if (f.sudo === "pass") checks.push({ key: "sudo", state: "info", title: `${s.username} needs a password for sudo`, detail: "Fine for most work. Installing packages from this panel will ask for it." });
      else if (f.sudo === "nopass") checks.push({ key: "sudo", state: "ok", title: `${s.username} can use sudo without a password`, detail: "Commands that need it run without asking." });
      else if (f.sudo === "root") checks.push({ key: "sudo", state: "warn", title: "Signed in as root", detail: "A normal user is safer than root." });
      else if (f.sudo === "none") checks.push({ key: "sudo", state: "info", title: "sudo is not installed", detail: `Only what ${s.username} may do can be done from here.` });
      // 6. Docker
      checks.push(f.docker
        ? { key: "docker", state: "ok", title: `Docker ${f.docker.replace(/^(\d+\.\d+).*/, "$1")} is installed`, detail: "You can deploy apps to this server later." }
        : { key: "docker", state: "info", title: "Docker is not installed", detail: "Not needed for a terminal. Deploying apps here would need it." });
      sys.checkedAt = new Date().toISOString();
      status = s.hostKeyFingerprint ? "connected" : "waiting_trust";
      note = s.hostKeyFingerprint ? (sys.latencyMs != null ? `${sys.latencyMs} ms` : null) : "Setup not finished";
    } finally {
      c.client.end();
    }
  } catch (e: any) {
    const code = e instanceof SshError ? e.code : "other";
    const msg = e instanceof SshError ? (code === "timeout" ? explain("timeout", t, lockAddress(settings)) : e.message) : String(e?.message ?? e);
    checks.push({ key: code === "auth" || code === "passphrase" ? "auth" : code === "hostkey" ? "hostkey" : "reach", state: "bad", title: code === "hostkey" ? "Wrong fingerprint" : code === "auth" ? "Permission denied" : code === "timeout" ? "Timed out" : "Could not connect", detail: msg });
    if (code === "hostkey") { status = "host_key_changed"; note = (await loadServer(s.id)).statusNote; }
    else if (code === "passphrase") { /* the server is fine; the person typed the wrong passphrase */ }
    else if (code === "auth") { status = s.status === "waiting_key" ? "waiting_key" : "auth_failed"; note = s.status === "waiting_key" ? "Key not on the server yet" : "Cannot sign in"; }
    else { status = s.status === "waiting_key" ? "waiting_key" : "unreachable"; note = code === "timeout" ? "Timed out" : "Could not connect"; }
  }
  const ok = !checks.some((c) => c.state === "bad");
  await db.update(sshServers).set({ status, statusNote: note, system: sys, lastCheckAt: new Date(), updatedAt: new Date() }).where(eq(sshServers.id, s.id));
  audit("ssh_test", o.actor, { id: s.id, name: s.name }, { ok, status });
  return { ok, checks, status };
}

/** Learns the host key without signing in (step 3 before anything was installed). */
export async function probe(s: SshServer) {
  if (s.hostKeyFingerprint) return { type: s.hostKeyType, fingerprint: s.hostKeyFingerprint, trusted: true };
  if (s.seenHostKeyFingerprint) return { type: s.seenHostKeyType, fingerprint: s.seenHostKeyFingerprint, trusted: false };
  let sock;
  let jump;
  if (s.jumpServerId) ({ sock, jump } = await viaJump(s, 0));
  try {
    const p = await probeHostKey(target(s), sock);
    await db.update(sshServers).set({ seenHostKeyType: p.type, seenHostKeyFingerprint: p.fingerprint }).where(eq(sshServers.id, s.id));
    return { type: p.type, fingerprint: p.fingerprint, trusted: false };
  } finally {
    jump?.end();
  }
}

/** The admin confirms the fingerprint they were shown. It must be the one the server shows now. */
export async function trust(s: SshServer, fingerprint: string, actor: Actor, opts: { replace?: boolean } = {}) {
  let shown: { type: string; fingerprint: string };
  let sock, jump;
  if (s.jumpServerId) ({ sock, jump } = await viaJump(s, 0));
  try {
    shown = await probeHostKey(target(s), sock);
  } finally {
    jump?.end();
  }
  if (shown.fingerprint !== fingerprint) throw bad(`The server now shows ${shown.fingerprint}, not the fingerprint you confirmed. Check the address and look again.`);
  if (s.hostKeyFingerprint && s.hostKeyFingerprint !== fingerprint && !opts.replace) throw bad("This server already has a trusted fingerprint. Replace it only if you know why it changed.");
  if (!s.hostKeyFingerprint && s.seenHostKeyFingerprint && s.seenHostKeyFingerprint !== fingerprint && !opts.replace) {
    throw bad("The server shows a different fingerprint from the first time Deploy King connected. Stop and check the address.");
  }
  const previous = s.hostKeyFingerprint;
  await db.update(sshServers).set({
    hostKeyType: shown.type, hostKeyFingerprint: fingerprint, hostKeyTrustedAt: new Date(),
    seenHostKeyType: shown.type, seenHostKeyFingerprint: fingerprint,
    ...(s.status === "host_key_changed" ? { status: "connected", statusNote: null } : {}),
    updatedAt: new Date(),
  }).where(eq(sshServers.id, s.id));
  audit("ssh_host_trust", actor, { id: s.id, name: s.name }, { fingerprint, type: shown.type, replaced: previous ?? undefined });
  return { type: shown.type, fingerprint };
}

/**
 * "Install it for me": signs in once with the password, adds the key, then checks that the key itself works.
 * The password is not stored. If the key does not work, its line is taken out again.
 */
export async function installWithPassword(s: SshServer, password: string, actor: Actor) {
  if (!s.keyId) throw bad("Create or choose a key first.");
  const key = await loadKey(s.keyId);
  const c = await openServer(s, { auth: { password }, actor }).catch((e) => {
    if (e instanceof SshError && e.code === "auth") throw bad(`Permission denied: the password for ${s.username} was not accepted.`);
    throw e instanceof SshError ? bad(e.message) : e;
  });
  const blob = blobBase64(key.publicKey);
  try {
    let from = key.fromAddress;
    if (from !== null) {
      // Locked: use the address this server actually sees the panel as.
      const r = await exec(c.client, "echo $SSH_CLIENT");
      const seen = r.stdout.trim().split(/\s+/)[0];
      if (seen && SAFE_FROM.test(seen)) {
        from = seen;
        await rememberSeenAddress(seen);
      } else if (!from) {
        throw bad("The server did not say which address the panel connects from, so the key cannot be locked to it. Set this panel's address on the SSH keys page.");
      }
      if (from !== key.fromAddress) await db.update(sshKeys).set({ fromAddress: from }).where(eq(sshKeys.id, key.id));
    }
    const line = authorizedLine(key.publicKey, { from, restrict: key.restrict });
    const add = await exec(c.client, addKeyScript(line, blob));
    if (add.code !== 0) throw bad(`The key could not be added: ${(add.stderr || add.stdout).trim().slice(0, 200) || "unknown error"}`);
    // Does the key work on its own?
    const fresh = await loadServer(s.id);
    try {
      const k = await openServer({ ...fresh, authMethod: "key" }, { actor });
      k.client.end();
    } catch (e: any) {
      await exec(c.client, removeKeyScript(blob)).catch(() => {});
      if (e instanceof SshError && e.code === "passphrase") throw bad("The key was added, but it has a passphrase. Test it on the next step with the passphrase.");
      throw bad(`The key was added but did not let Deploy King sign in, so it was taken out again. ${e?.message ?? ""}`.trim());
    }
    const trusted = !!fresh.hostKeyFingerprint;
    await db.update(sshServers).set({
      authMethod: "key", status: trusted ? "connected" : "waiting_trust", statusNote: trusted ? null : "Setup not finished", updatedAt: new Date(),
    }).where(eq(sshServers.id, s.id));
    audit("ssh_key_install", actor, { id: s.id, name: s.name }, { key: key.fingerprint, from, by: "one-time password" });
    return { installed: true, from };
  } finally {
    c.client.end();
  }
}

/**
 * Rotation, as the SSH keys page explains it: a new key pair; sign in with the old key and add the new public key;
 * test the new key; then remove the old one. If adding or testing fails on any server, the new key is taken out
 * everywhere it was added and deleted: nothing changes.
 */
export async function rotateKey(keyId: string, actor: Actor) {
  const old = await loadKey(keyId);
  if (old.hasPassphrase) throw bad("A key with a passphrase cannot be rotated from here: Deploy King cannot sign in with it on its own.");
  const users = await db.select().from(sshServers).where(and(eq(sshServers.keyId, keyId), ne(sshServers.authMethod, "password")));
  if (users.length === 0) throw bad("No server uses this key. Delete it instead.");
  const pending = users.filter((s) => s.status === "waiting_key");
  if (pending.length) throw bad(`${pending.map((s) => s.name).join(", ")} does not have this key yet. Finish its setup first.`);
  const label = old.label;
  const fresh = await createKey({ type: (old.type === "rsa" ? "rsa4096" : old.type) as KeyType, label, lock: old.fromAddress !== null, restrict: old.restrict, rotateDays: old.rotateAfterDays, actor, rotatedFromId: old.id });
  const newBlob = blobBase64(fresh.publicKey), oldBlob = blobBase64(old.publicKey);
  const added: SshServer[] = [];
  const steps: Array<{ server: string; step: string; ok: boolean; detail?: string }> = [];
  let failure: string | null = null;
  let freshFrom = fresh.fromAddress;
  for (const s of users) {
    let c: Connection | null = null;
    try {
      c = await openServer(s, { requireTrusted: true, actor });
      let from = old.fromAddress === null ? null : old.fromAddress || freshFrom;
      if (old.fromAddress !== null) {
        const seen = (await exec(c.client, "echo $SSH_CLIENT")).stdout.trim().split(/\s+/)[0];
        if (seen && SAFE_FROM.test(seen)) from = seen;
      }
      if (from !== freshFrom) { await db.update(sshKeys).set({ fromAddress: from }).where(eq(sshKeys.id, fresh.id)); freshFrom = from; }
      const add = await exec(c.client, addKeyScript(authorizedLine(fresh.publicKey, { from, restrict: fresh.restrict }), newBlob));
      if (add.code !== 0) throw new Error((add.stderr || add.stdout).trim() || "could not write authorized_keys");
      added.push(s);
      steps.push({ server: s.name, step: "added", ok: true });
      const t = await openServer({ ...s, keyId: fresh.id }, { requireTrusted: true, actor });
      t.client.end();
      steps.push({ server: s.name, step: "tested", ok: true });
    } catch (e: any) {
      failure = `${s.name}: ${e?.message ?? e}`;
      steps.push({ server: s.name, step: added.includes(s) ? "test" : "add", ok: false, detail: String(e?.message ?? e) });
    } finally {
      c?.client.end();
    }
    if (failure) break;
  }
  if (failure) {
    // Take the new key out wherever it went in, with the old key, which still works there.
    for (const s of added) {
      try {
        const c = await openServer(s, { requireTrusted: true, actor });
        await exec(c.client, removeKeyScript(newBlob));
        c.client.end();
      } catch {}
    }
    await db.delete(sshKeys).where(eq(sshKeys.id, fresh.id));
    audit("ssh_key_rotate", actor, { id: old.id, type: "ssh_key", name: old.label }, { ok: false, failure, steps });
    return { ok: false as const, message: `The new key did not work, so nothing changed. ${failure}`, steps };
  }
  // Every server accepts the new key: switch, then remove the old key using the new one.
  await db.update(sshServers).set({ keyId: fresh.id, updatedAt: new Date() }).where(inArray(sshServers.id, users.map((s) => s.id)));
  const leftovers: string[] = [];
  for (const s of users) {
    try {
      const c = await openServer({ ...s, keyId: fresh.id }, { requireTrusted: true, actor });
      const r = await exec(c.client, removeKeyScript(oldBlob));
      c.client.end();
      if (r.code !== 0) throw new Error("still there");
      steps.push({ server: s.name, step: "old key removed", ok: true });
    } catch (e: any) {
      leftovers.push(s.name);
      steps.push({ server: s.name, step: "old key removed", ok: false, detail: String(e?.message ?? e) });
    }
  }
  if (leftovers.length === 0) await db.delete(sshKeys).where(eq(sshKeys.id, old.id));
  audit("ssh_key_rotate", actor, { id: fresh.id, type: "ssh_key", name: fresh.label }, { ok: true, from: old.fingerprint, to: fresh.fingerprint, servers: users.map((s) => s.name), leftovers });
  return {
    ok: true as const,
    keyId: fresh.id,
    fingerprint: fresh.fingerprint,
    message: leftovers.length ? `Rotated. The old key could not be removed from ${leftovers.join(", ")}; remove it by hand, then delete it here.` : `Rotated on ${users.length} server${users.length === 1 ? "" : "s"}. The old key was removed.`,
    steps,
  };
}

/** Uses the stored password only when the security default allows passwords. */
export async function setStoredPassword(s: SshServer, password: string, actor: Actor) {
  const settings = await getSettings();
  if (!settings.allowPasswordSignIn) throw bad("Password sign-in to servers is turned off under SSH keys, Security defaults.");
  const enc = encrypt(password);
  await db.update(sshServers).set({ authMethod: "password", encryptedPassword: enc.encryptedValue, passwordIv: enc.iv, passwordAuthTag: enc.authTag, status: s.hostKeyFingerprint ? "connected" : "waiting_trust", statusNote: s.hostKeyFingerprint ? null : "Setup not finished", updatedAt: new Date() }).where(eq(sshServers.id, s.id));
  audit("ssh_server_update", actor, { id: s.id, name: s.name }, { storedPassword: true });
}
