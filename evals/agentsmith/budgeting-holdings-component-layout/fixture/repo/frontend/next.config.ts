import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The repository root has a separate MatrixCore lockfile. Keep Turbopack's
  // module graph anchored to this application so its IDs remain stable.
  turbopack: { root: path.resolve(__dirname) },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
    ];
  },
};

export default nextConfig;
