import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Company fixtures used to be bundled into the client. Nothing under
  // src/server may ever be imported from a client component again; the
  // `server-only` guard in src/server/db.ts enforces that at build time.
  experimental: {
    typedRoutes: true,
  },
  // @napi-rs/canvas loads a platform-specific .node binary, which a bundler
  // cannot place in an ESM chunk. It renders PDF pages to images on the
  // server and is never reachable from the client, so it is required at
  // runtime instead of bundled. pdfjs-dist rides along for the same reason:
  // its legacy build resolves fonts and workers relative to itself.
  serverExternalPackages: ['@napi-rs/canvas', 'pdfjs-dist'],
  // Next writes AGENTS.md/CLAUDE.md by default; this repo keeps its own docs.
  agentRules: false,
};

export default nextConfig;
