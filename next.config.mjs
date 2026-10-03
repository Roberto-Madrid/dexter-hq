/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "yaml", "zod"],
  typescript: { tsconfigPath: "tsconfig.app.json" },
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
