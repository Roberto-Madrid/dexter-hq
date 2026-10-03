import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "supabase/functions/_shared/**",
      "tools/**",
      "scripts/**",
      ".agent-work/**",
      ".next/**",
      "app/generated/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["kernel/**/*.ts", "adapters/**/*.ts", "hq/**/*.ts", "gateway/**/*.ts", "tests/**/*.ts", "app/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
