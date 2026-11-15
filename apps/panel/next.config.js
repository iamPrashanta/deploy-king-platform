/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@dbbkp/api", "@dbbkp/db", "@dbbkp/trpc"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:4000/api/:path*",
      },
      {
        source: "/trpc/:path*",
        destination: "http://localhost:4000/trpc/:path*",
      },
      {
        // workflow trigger URLs
        source: "/hooks/:path*",
        destination: "http://localhost:4000/hooks/:path*",
      },
      {
        // GitHub can reach the API through the panel's address
        source: "/webhooks/:path*",
        destination: "http://localhost:4000/webhooks/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
