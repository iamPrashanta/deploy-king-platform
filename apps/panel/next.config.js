/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@dbbkp/api", "@dbbkp/db", "@dbbkp/trpc"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: (process.env.DK_API_URL || "http://localhost:4000") + "/api/:path*",
      },
      {
        source: "/trpc/:path*",
        destination: (process.env.DK_API_URL || "http://localhost:4000") + "/trpc/:path*",
      },
      {
        // workflow trigger URLs
        source: "/hooks/:path*",
        destination: (process.env.DK_API_URL || "http://localhost:4000") + "/hooks/:path*",
      },
      {
        // MCP server for AI agents, and the guide they read first
        source: "/mcp",
        destination: (process.env.DK_API_URL || "http://localhost:4000") + "/mcp",
      },
      {
        source: "/llms.txt",
        destination: (process.env.DK_API_URL || "http://localhost:4000") + "/llms.txt",
      },
      {
        // GitHub can reach the API through the panel's address
        source: "/webhooks/:path*",
        destination: (process.env.DK_API_URL || "http://localhost:4000") + "/webhooks/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
