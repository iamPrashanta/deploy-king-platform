const path = require("path");

// Where the panel's server forwards API calls. In a container this is the API container
// (http://dbbkp-api:4000); in development the API on this machine.
// Next.js fixes rewrites at build time, so the panel image builds with a placeholder and its
// start script puts the real address in (apps/panel/docker-entrypoint.sh).
// DK_API_URL and API_INTERNAL_URL are the same setting (two names from two branches); DK_API_URL wins.
const API = (process.env.DK_API_URL || process.env.API_INTERNAL_URL || "http://localhost:4000").replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@dbbkp/api", "@dbbkp/db", "@dbbkp/trpc"],
  // A self-contained server in .next/standalone, for the container image.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API}/api/:path*`,
      },
      {
        source: "/trpc/:path*",
        destination: `${API}/trpc/:path*`,
      },
      {
        // workflow trigger URLs
        source: "/hooks/:path*",
        destination: `${API}/hooks/:path*`,
      },
      {
        // MCP server for AI agents, and the guide they read first
        source: "/mcp",
        destination: `${API}/mcp`,
      },
      {
        // the assistant's ZIP upload (POST /mcp/upload)
        source: "/mcp/:path*",
        destination: `${API}/mcp/:path*`,
      },
      {
        source: "/llms.txt",
        destination: `${API}/llms.txt`,
      },
      {
        // GitHub can reach the API through the panel's address
        source: "/webhooks/:path*",
        destination: `${API}/webhooks/:path*`,
      },
      {
        // live logs and the terminal (WebSockets are forwarded too)
        source: "/ws",
        destination: `${API}/ws`,
      },
      {
        source: "/ws/:path*",
        destination: `${API}/ws/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
