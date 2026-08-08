/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // argon2 and sharp are native modules; bundling them breaks them.
  serverExternalPackages: ['@node-rs/argon2', 'sharp'],

  // Standalone output is for the Docker image only. Hosts with their own
  // Next.js adapter (Netlify, Vercel, Amplify) expect the default `.next`
  // output and find nothing to publish when this is on — which surfaces as
  // "Site not found" rather than as a build error.
  ...(process.env.BUILD_STANDALONE === 'true' ? { output: 'standalone' } : {}),
};

export default nextConfig;
