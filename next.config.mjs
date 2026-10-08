/** @type {import('next').NextConfig} */
// Persona files are read at runtime by launch briefs and Council seat prompts (hq/personas.ts); they are tiny.
const tracedAssets = ["./gateway/role-sheet.yaml", "./crews/*.yaml", "./personas/*.md"];
// age decrypts and re-encrypts the path B login in both routes that run a Codex seat.
// The Codex binary itself is never traced: hq/codex-bin.ts fetches and verifies it at runtime
// (function storage is capped). scripts/check-traces.mjs enforces both rules after every build.
const pathBAssets = [...tracedAssets, "./vendor/age/age", "./workers/age.pub"];

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "yaml", "zod"],
  typescript: { tsconfigPath: "tsconfig.app.json" },
  allowedDevOrigins: ["127.0.0.1"],
  outputFileTracingIncludes: {
    "/": tracedAssets,
    "/api/*": tracedAssets,
    "/api/**": tracedAssets,
    "/api/chat": pathBAssets,
    "/api/mcp": pathBAssets,
  },
  outputFileTracingExcludes: {
    "*": ["./vendor/codex/**"],
  },
};

export default nextConfig;
