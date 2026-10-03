import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as esbuild from "esbuild";

const outfile = "app/generated/hq.js";
mkdirSync(dirname(outfile), { recursive: true });
await esbuild.build({
  entryPoints: ["hq/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile,
  logLevel: "warning",
});
