"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import React, { useState } from "react";
import { trpc } from "../utils/trpc";

const getBaseUrl = () => {
  if (typeof window !== "undefined") return ""; // the browser goes through the Next.js rewrite
  return process.env.API_INTERNAL_URL || "http://localhost:4000";
};

export default function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Show cached data instantly when moving between pages and refresh in the background.
            staleTime: 10_000,
            cacheTime: 10 * 60_000,
            refetchOnWindowFocus: true,
            retry: (count, err: any) => count < 2 && !["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"].includes(err?.data?.code),
          },
        },
      })
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/trpc`,
          headers() {
            if (typeof window === "undefined") return {};
            const token = localStorage.getItem("token");
            return token ? { authorization: `Bearer ${token}` } : {};
          },
        }),
      ],
    } as any)
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
