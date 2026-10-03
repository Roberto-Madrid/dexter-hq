/** @type {import('next').NextConfig} */
const tracedAssets = ["./gateway/role-sheet.yaml", "./crews/*.yaml"];

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "yaml", "zod"],
  typescript: { tsconfigPath: "tsconfig.app.json" },
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingIncludes: {
    "/": tracedAssets,
    "/api/*": tracedAssets,
    "/api/**": tracedAssets,
  },
};

export default nextConfig;
