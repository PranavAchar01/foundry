import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the trace root: a stray lockfile in a parent directory otherwise makes
  // Next infer the wrong workspace root.
  outputFileTracingRoot: path.resolve(process.cwd()),
  // Native / dynamically-resolved modules that must not be bundled.
  serverExternalPackages: ['pg', '@vercel/sandbox', 'playwright'],
  eslint: {
    // Lint is a separate, enforced CI step (`pnpm lint`); don't double-run it during build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
