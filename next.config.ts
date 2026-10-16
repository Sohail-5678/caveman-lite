import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // lets a production build run beside `next dev` without sharing .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    // CORS for /api/v1/* is set by the route itself (src/lib/server/http.ts): static headers here would
    // override its preflight, which echoes the SDK's x-stainless-* headers and exposes x-cache & co.
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
