import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Company fixtures used to be bundled into the client. Nothing under
  // src/server may ever be imported from a client component again; the
  // `server-only` guard in src/server/db.ts enforces that at build time.
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
