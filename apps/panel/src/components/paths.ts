/** Pages shown without the sidebar and header. */
export const isBarePath = (p: string) => p === "/login" || p === "/setup/password" || isOpenPath(p);

/** Pages anyone may open without signing in: accepting an invitation, and asking for access. */
export const isOpenPath = (p: string) => p === "/signup" || p.startsWith("/invite/");
