import { TRPCError } from "@trpc/server";
import { db, gitProviders } from "@dbbkp/db";
import { and, eq } from "drizzle-orm";
import { decrypt } from "@dbbkp/security";
import type { AuthedUser } from "../middleware/requireAuth";

const GH = "https://api.github.com";

async function gh<T>(token: string, path: string): Promise<{ data: T; link: string | null }> {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "dbbkp-platform",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new TRPCError({ code: "UNAUTHORIZED", message: "GitHub rejected the token (expired or revoked?)" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TRPCError({ code: "BAD_REQUEST", message: `GitHub API ${res.status}: ${body.slice(0, 200)}` });
  }
  return { data: (await res.json()) as T, link: res.headers.get("link") };
}

export async function githubUser(token: string) {
  const { data } = await gh<any>(token, "/user");
  return { login: String(data.login), name: data.name ? String(data.name) : null, avatarUrl: data.avatar_url ? String(data.avatar_url) : null };
}

export type GithubRepo = {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
};

export async function githubRepos(token: string): Promise<GithubRepo[]> {
  const out: GithubRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const { data, link } = await gh<any[]>(
      token,
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
    );
    for (const r of data) {
      out.push({
        fullName: r.full_name,
        name: r.name,
        private: !!r.private,
        defaultBranch: r.default_branch || "main",
        cloneUrl: r.clone_url,
        description: r.description ?? null,
        language: r.language ?? null,
        pushedAt: r.pushed_at ?? null,
      });
    }
    if (!link || !link.includes('rel="next"')) break;
  }
  return out;
}

/** Loads a provider the user may use and returns it with its decrypted token. */
export async function providerWithToken(user: AuthedUser | { sub: string; role: string }, providerId: string) {
  const where =
    user.role === "admin"
      ? eq(gitProviders.id, providerId)
      : and(eq(gitProviders.id, providerId), eq(gitProviders.userId, user.sub));
  const [p] = await db.select().from(gitProviders).where(where).limit(1);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Git provider not found" });
  const token = decrypt({ encryptedValue: p.encryptedToken, iv: p.iv, authTag: p.authTag });
  return { provider: p, token };
}
