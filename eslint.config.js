import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "supabase/functions/_shared/**",
      "tools/**",
      "scripts/**",
      ".agent-work/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["kernel/**/*.ts", "adapters/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
