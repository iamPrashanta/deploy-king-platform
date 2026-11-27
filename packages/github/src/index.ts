import crypto from "node:crypto";
import { db, gitProviders, githubAppInstallations, platformSettings, type GitProvider } from "@dbbkp/db";
import { decrypt, encrypt, type EncryptedPayload } from "@dbbkp/security";
import { eq } from "drizzle-orm";

/**
 * This panel's GitHub App: made in one click on GitHub from a manifest, then installed on accounts and
 * organizations. Its private key, webhook secret and client secret are stored encrypted with MASTER_KEY.
 * Each installation has a git_providers row of type "github_app"; a short-lived token is made for it
 * whenever repositories are listed or cloned. Used by the API and by the worker.
 */

export const APP_KEY = "github_app";
const GH = "https://api.github.com";

export type GithubAppStored = {
  appId: number;
  slug: string;
  name: string;
  owner: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: EncryptedPayload;
  webhookSecret: EncryptedPayload;
  pem: EncryptedPayload;
  createdAt: string;
  createdBy: string | null;
};

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
let testFetch: FetchLike | null = null;
/** Tests only: GitHub API calls go here instead of the network. */
export function setGithubFetchForTests(f: FetchLike | null) {
  testFetch = f;
  tokenCache.clear();
}

export class GithubError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call<T = any>(path: string, opts: { method?: string; auth?: string; body?: unknown } = {}): Promise<T> {
  const f: FetchLike = testFetch ?? ((u, i) => fetch(u, i as RequestInit) as any);
  const res = await f(`${GH}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "deploy-king",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.auth ? { Authorization: opts.auth } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 200);
    try {
      msg = JSON.parse(text).message ?? msg;
    } catch {}
    throw new GithubError(`GitHub answered ${res.status}: ${msg}`, res.status);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// ─── The App itself ──────────────────────────────────────────────────────────

export async function getApp(): Promise<GithubAppStored | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, APP_KEY)).limit(1);
  return (row?.value as GithubAppStored) ?? null;
}

/** The app's webhook secret, for checking signatures on /webhooks/github. */
export async function appWebhookSecret(): Promise<string | null> {
  const app = await getApp();
  if (!app) return null;
  try {
    return decrypt(app.webhookSecret);
  } catch {
    return null;
  }
}

/** What GitHub is asked to create. Read access to code only, plus the push and pull request events. */
export function appManifest(opts: { name: string; panelUrl: string; webhookUrl: string }) {
  return {
    name: opts.name.slice(0, 34),
    url: opts.panelUrl,
    hook_attributes: { url: opts.webhookUrl, active: true },
    redirect_url: `${opts.panelUrl}/settings/github`,
    setup_url: `${opts.panelUrl}/settings/github`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    default_events: ["push", "pull_request"],
  };
}

/** Step 1 finished on GitHub: trade the one-time code for the app's id and keys, and keep them encrypted. */
export async function completeManifest(code: string, userId: string | null): Promise<GithubAppStored> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GithubError("Not a code from GitHub", 400);
  const r = await call<any>(`/app-manifests/${code}/conversions`, { method: "POST" });
  const value: GithubAppStored = {
    appId: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    owner: String(r.owner?.login ?? ""),
    htmlUrl: String(r.html_url ?? `https://github.com/apps/${r.slug}`),
    clientId: String(r.client_id ?? ""),
    clientSecret: encrypt(String(r.client_secret ?? "")),
    webhookSecret: encrypt(String(r.webhook_secret ?? "")),
    pem: encrypt(String(r.pem)),
    createdAt: new Date().toISOString(),
    createdBy: userId,
  };
  if (!value.appId || !value.slug || !r.pem) throw new GithubError("GitHub did not send the app's keys", 502);
  await db.insert(platformSettings).values({ key: APP_KEY, value, updatedBy: userId }).onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  return value;
}

/** A JWT that proves we are the app (RS256, valid 9 minutes). */
export function appJwt(app: Pick<GithubAppStored, "appId" | "pem">, now = Date.now()) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 540, iss: String(app.appId) })}`;
  const sig = crypto.createSign("RSA-SHA256").update(head).sign(decrypt(app.pem)).toString("base64url");
  return `${head}.${sig}`;
}

// ─── Installations ───────────────────────────────────────────────────────────

export type Installation = { id: number; account: string; accountType: string; avatarUrl: string | null; repositorySelection: string; suspended: boolean; htmlUrl: string | null };

const asInstallation = (i: any): Installation => ({
  id: Number(i.id),
  account: String(i.account?.login ?? ""),
  accountType: String(i.account?.type ?? "User"),
  avatarUrl: i.account?.avatar_url ? String(i.account.avatar_url) : null,
  repositorySelection: i.repository_selection === "all" ? "all" : "selected",
  suspended: !!i.suspended_at,
  htmlUrl: i.html_url ? String(i.html_url) : null,
});

export async function listInstallations(app: GithubAppStored): Promise<Installation[]> {
  const out: Installation[] = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await call<any[]>(`/app/installations?per_page=100&page=${page}`, { auth: `Bearer ${appJwt(app)}` });
    out.push(...rows.map(asInstallation));
    if (rows.length < 100) break;
  }
  return out;
}

/** Records one installation, with the git provider that apps point at. */
export async function saveInstallation(inst: Installation, userId: string) {
  const [known] = await db.select().from(githubAppInstallations).where(eq(githubAppInstallations.installationId, inst.id)).limit(1);
  const name = `GitHub App · ${inst.account}`;
  if (known) {
    await db.update(githubAppInstallations).set({ account: inst.account, accountType: inst.accountType, repositorySelection: inst.repositorySelection, suspendedAt: inst.suspended ? new Date() : null, updatedAt: new Date() }).where(eq(githubAppInstallations.installationId, inst.id));
    await db.update(gitProviders).set({ name, login: inst.account, avatarUrl: inst.avatarUrl }).where(eq(gitProviders.id, known.providerId));
    return known.providerId;
  }
  // There is no long-lived token for an installation; the column holds a marker so the row stays valid.
  const marker = encrypt(`github-app-installation:${inst.id}`);
  const [p] = await db
    .insert(gitProviders)
    .values({ userId, type: "github_app", name, login: inst.account, avatarUrl: inst.avatarUrl, encryptedToken: marker.encryptedValue, iv: marker.iv, authTag: marker.authTag })
    .returning({ id: gitProviders.id });
  await db.insert(githubAppInstallations).values({ installationId: inst.id, providerId: p.id, account: inst.account, accountType: inst.accountType, repositorySelection: inst.repositorySelection, suspendedAt: inst.suspended ? new Date() : null });
  return p.id;
}

/** Brings the list in step with GitHub. Installations that were removed on GitHub are removed here too. */
export async function syncInstallations(userId: string) {
  const app = await getApp();
  if (!app) return { installations: 0, removed: 0 };
  const live = await listInstallations(app);
  for (const i of live) await saveInstallation(i, userId);
  const ids = new Set(live.map((i) => i.id));
  const known = await db.select().from(githubAppInstallations);
  let removed = 0;
  for (const k of known) {
    if (ids.has(k.installationId)) continue;
    await db.delete(gitProviders).where(eq(gitProviders.id, k.providerId)); // cascades to the installation row
    removed += 1;
  }
  return { installations: live.length, removed };
}

const tokenCache = new Map<number, { token: string; expires: number }>();

/** A token for one installation, valid about an hour. Kept in memory until five minutes before it ends. */
export async function installationToken(installationId: number): Promise<string> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.expires - 5 * 60_000 > Date.now()) return hit.token;
  const app = await getApp();
  if (!app) throw new GithubError("The GitHub App is not set up in Settings › GitHub", 412);
  const r = await call<any>(`/app/installations/${installationId}/access_tokens`, { method: "POST", auth: `Bearer ${appJwt(app)}` });
  const token = String(r.token);
  tokenCache.set(installationId, { token, expires: Date.parse(r.expires_at) || Date.now() + 50 * 60_000 });
  return token;
}

/** The token for any git provider row: the stored one for a personal token, a fresh one for an App installation. */
export async function tokenForProvider(p: GitProvider): Promise<string> {
  if (p.type === "github_app") {
    const [inst] = await db.select().from(githubAppInstallations).where(eq(githubAppInstallations.providerId, p.id)).limit(1);
    if (!inst) throw new GithubError("This GitHub App installation was removed. Install the app again in Settings › GitHub.", 404);
    return installationToken(inst.installationId);
  }
  return decrypt({ encryptedValue: p.encryptedToken, iv: p.iv, authTag: p.authTag });
}

/** Repositories an installation may see. */
export async function installationRepos(installationId: number) {
  const token = await installationToken(installationId);
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await call<any>(`/installation/repositories?per_page=100&page=${page}`, { auth: `Bearer ${token}` });
    out.push(...(r.repositories ?? []));
    if ((r.repositories ?? []).length < 100) break;
  }
  return out;
}

/** Forget the app: its keys, and every installation's provider row. Apps that used them keep their repository URL. */
export async function removeApp() {
  const known = await db.select().from(githubAppInstallations);
  for (const k of known) await db.delete(gitProviders).where(eq(gitProviders.id, k.providerId));
  await db.delete(platformSettings).where(eq(platformSettings.key, APP_KEY));
  tokenCache.clear();
  return { installations: known.length };
}

/** Signs a short-lived "state" for the manifest flow, so only the admin who started it can finish it. */
export function signState(userId: string, secret: string, now = Date.now()) {
  const body = `${userId}.${Math.floor(now / 1000) + 3600}`;
  const mac = crypto.createHmac("sha256", secret).update("gh-app-state:" + body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${mac}`;
}

export function checkState(state: string, userId: string, secret: string, now = Date.now()) {
  const [b, mac] = state.split(".");
  if (!b || !mac) return false;
  const body = Buffer.from(b, "base64url").toString();
  const want = crypto.createHmac("sha256", secret).update("gh-app-state:" + body).digest("base64url");
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return false;
  const [uid, exp] = body.split(".");
  return uid === userId && Number(exp) * 1000 > now;
}
