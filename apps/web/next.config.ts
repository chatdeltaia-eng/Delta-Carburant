import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const apiHost = process.env.API_INTERNAL_HOSTPORT ?? "localhost:3001";
    return [
      {
        source: "/api/v1/:path*",
        destination: `http://${apiHost}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
