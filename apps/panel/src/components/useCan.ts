"use client";

import { trpc } from "@/utils/trpc";

/**
 * Whether the signed-in user may do something, for hiding buttons they cannot use. The server checks again.
 * Accounts from before team roles ("member") use the older permission tables, so their buttons stay visible.
 */
export function useCan() {
  const me = trpc.team.me.useQuery(undefined, { staleTime: 60_000 });
  const d = me.data as { role: string; can: string[] } | undefined;
  return (permission: string) => !d || d.role === "member" || d.can.includes("*") || d.can.includes(permission);
}
