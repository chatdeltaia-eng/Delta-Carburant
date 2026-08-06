import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const apiBaseUrl =
      process.env.API_BASE_URL ??
      (process.env.NODE_ENV === "production"
        ? "https://delta-carburant-api.onrender.com"
        : "http://localhost:3001");
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiBaseUrl.replace(/\/$/, "")}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
