/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // argon2 and sharp are native modules; bundling them breaks them.
  serverExternalPackages: ['@node-rs/argon2', 'sharp'],
  // Emits a self-contained server with only the files it actually needs, so
  // the production image does not carry node_modules.
  output: 'standalone',
};

export default nextConfig;
