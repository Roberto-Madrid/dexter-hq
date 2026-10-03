import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as esbuild from "esbuild";

const outfile = process.argv[2] ?? "supabase/functions/_shared/kernel.js";
mkdirSync(dirname(outfile), { recursive: true });
await esbuild.build({
  entryPoints: ["kernel/index.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile,
  logLevel: "warning",
});
